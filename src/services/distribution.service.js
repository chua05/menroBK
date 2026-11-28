const {
  db,
} = require("../config/firebase");

const { isDistributionOwner, loadDistributionRequest } = require("../utils/distributionOwnership.util");
const { batchDateText } = require("../utils/batchDate.util");
const { hasReportableBalance } = require("../utils/plantingBalance.util");

const COLLECTION =
  "distributions";

const distributionCollection =
  db.collection(COLLECTION);

// ========================================
// HELPER — NORMALIZE REQUEST ITEMS
// ========================================

const ALLOCATION_KEYS = ["batchReference", "inventoryNumber", "sourceType", "sourceSpecification", "dateReceived"];

// Staff-only release-time batch snapshot. Empty strings are kept so "snapshotted empty" differs from "not snapshotted".
const normalizeBatchAllocations = (value) =>
  Array.isArray(value)
    ? value.map((entry) => ({
        inventoryId: String(entry?.inventoryId || ""),
        itemIndex: Number.isInteger(entry?.itemIndex) ? entry.itemIndex : -1,
        ...Object.fromEntries(ALLOCATION_KEYS.map((key) => [key, String(entry?.[key] ?? "")])),
      }))
    : [];

const normalizeRequestItems = (
  requestData
) => {
  if (
    Array.isArray(
      requestData.items
    ) &&
    requestData.items.length > 0
  ) {
    return requestData.items.map(
      (item) => ({
        inventoryId:
          item.inventoryId,

        species:
          item.species || "",

        scientificName:
          item.scientificName ||
          "",

        category:
          item.category || "",

        quantity:
          Number(
            item.quantity || 0
          ),
        requestedQuantity: Number(item.requestedQuantity ?? item.quantity ?? 0),
        releasedQuantity: Number(item.releasedQuantity ?? item.quantity ?? 0),
        difference: Number(item.difference ?? 0),
        releaseType: item.releaseType || "Complete",
        shortReleaseReason: item.shortReleaseReason || "",
      })
    );
  }

  // Backward compatibility for old
  // single-item request records.
  if (
    requestData.inventoryId
  ) {
    return [
      {
        inventoryId:
          requestData.inventoryId,

        species:
          requestData.species ||
          "",

        scientificName:
          requestData
            .scientificName || "",

        category:
          requestData.category ||
          "",

        quantity:
          Number(
            requestData.quantity ||
            0
          ),
      },
    ];
  }

  return [];
};

// ========================================
// CREATE DISTRIBUTION INSIDE TRANSACTION
// ========================================

const createDistributionRecordInTransaction = (
  transaction,
  {
    requestId,
    requestData,
    releasedBy,
    releasedAt,
  }
) => {
  // One distribution document per request.
  const distributionRef =
    distributionCollection.doc(
      requestId
    );

  const items =
    normalizeRequestItems(
      requestData
    );

  if (items.length === 0) {
    throw new Error(
      "Distribution has no seedling items."
    );
  }

  const totalQuantityReleased =
    items.reduce(
      (
        total,
        item
      ) =>
        total +
        Number(
          item.quantity || 0
        ),
      0
    );

  const proposal =
    requestData.eventProposal ||
    {};
  const distributionNumber = /^REQ-\d{4}-\d{3,}$/.test(requestData.requestNumber || "")
    ? requestData.requestNumber.replace(/^REQ-/, "DIST-")
    : "";

  const distributionData = {
    distributionNumber,
    requestId,
    requestNumber: requestData.requestNumber || "",
    ...(requestData.approvedPurposePolicy ? { reportingPolicy: require("./purposePolicy.service").releasePolicy(requestData.approvedPurposePolicy, totalQuantityReleased) } : {}),

    participantId:
      requestData.participantId,

    participantName:
      requestData.participantName,

    participantType:
      requestData.workflow?.sector || requestData.participantType || requestData.userType || "",

    barangay:
      requestData.barangay || requestData.participantBarangay || "",

    organization:
      requestData.organization,

    contactNumber:
      requestData.contactNumber,

    // Canonical multi-item structure.
    items,

    batchAllocations: normalizeBatchAllocations(requestData.batchAllocations),

    totalQuantityReleased,

    purpose:
      requestData.purpose,

    plantingSiteId:
      proposal.plantingSiteId ||
      requestData.plantingSiteId ||
      "",

    plantingLocation:
      requestData.plantingLocation ||
      proposal.eventLocation ||
      "",

    preferredReleaseDate:
      requestData
        .preferredReleaseDate,

    eventId:
      requestData.eventId || "",

    reviewedBy:
      requestData.reviewedBy ||
      "",

    approvedBy:
      requestData.approvedBy ||
      "",

    releasedBy,

    status:
      "Released",

    releasedAt,

    createdAt:
      releasedAt,
  };

  transaction.set(
    distributionRef,
    distributionData
  );

  return {
    id:
      distributionRef.id,

    ...distributionData,
  };
};

// ========================================
// READ-TIME ENRICHMENT (admin/staff reads only, no writes)
// ========================================

const readDocs = async (refs) => {
  if (refs.length === 0) return [];
  if (typeof db.getAll === "function") return db.getAll(...refs);
  return Promise.all(refs.map((docRef) => docRef.get()));
};

const enrichDistributions = async (distributions) => {
  const inventoryIds = new Set();
  const userIds = new Set();
  for (const distribution of distributions) {
    for (const item of Array.isArray(distribution.items) ? distribution.items : []) {
      if (item && typeof item.inventoryId === "string" && item.inventoryId) inventoryIds.add(item.inventoryId);
    }
    if (typeof distribution.releasedBy === "string" && distribution.releasedBy) userIds.add(distribution.releasedBy);
  }
  const inventoryList = [...inventoryIds];
  const userList = [...userIds];
  const docs = await readDocs([
    ...inventoryList.map((id) => db.collection("seedlingInventory").doc(id)),
    ...userList.map((id) => db.collection("users").doc(id)),
  ]);
  const inventoryById = new Map(inventoryList.map((id, index) => [id, docs[index]]));
  const userById = new Map(userList.map((id, index) => [id, docs[inventoryList.length + index]]));

  const fieldsFrom = (source) =>
    Object.fromEntries(ALLOCATION_KEYS.map((key) => [key, key === "dateReceived" ? batchDateText(source?.[key]) : String(source?.[key] ?? "")]));

  return distributions.map((distribution) => {
    const userDoc = userById.get(distribution.releasedBy);
    const user = userDoc && userDoc.exists ? userDoc.data() || {} : {};
    const releasedByName = String(user.fullName || user.name || user.displayName || "");
    const snapshots = Array.isArray(distribution.batchAllocations) ? distribution.batchAllocations : [];
    const items = Array.isArray(distribution.items)
      ? distribution.items.map((item, index) => {
          const inventoryId = item?.inventoryId || "";
          const inventoryDoc = inventoryById.get(item?.inventoryId);
          const live = inventoryDoc && inventoryDoc.exists ? inventoryDoc.data() || {} : null;
          const snapshot = snapshots.find((entry) => entry && entry.itemIndex === index && entry.inventoryId === inventoryId);
          // All-or-nothing: never merge release-time and current fields.
          let basis = "unavailable";
          let fields = fieldsFrom({});
          if (snapshot) {
            basis = "release";
            fields = fieldsFrom(snapshot);
          } else if (live) {
            basis = "current-record";
            fields = fieldsFrom(live);
          }
          return {
            ...item,
            allocation: {
              inventoryId,
              ...fields,
              basis,
              liveRecordFound: Boolean(live),
              recordFound: basis !== "unavailable",
            },
          };
        })
      : distribution.items;
    return { ...distribution, items, releasedByName };
  });
};

// ========================================
// GET ALL DISTRIBUTIONS
// ========================================

const getAllDistributions =
  async (
    {
      species,
      participantId,
      requestId,
    } = {}
  ) => {
    const snapshot =
      await distributionCollection.get();

    let distributions =
      snapshot.docs.map(
        (doc) => ({
          id:
            doc.id,

          ...doc.data(),
        })
      );

    if (species) {
      const searchSpecies =
        String(
          species
        )
          .trim()
          .toLowerCase();

      distributions =
        distributions.filter(
          (distribution) => {
            const items =
              normalizeRequestItems(
                distribution
              );

            return items.some(
              (item) =>
                String(
                  item.species ||
                    ""
                )
                  .toLowerCase()
                  .includes(
                    searchSpecies
                  )
            );
          }
        );
    }

    if (participantId) {
      distributions =
        distributions.filter(
          (distribution) =>
            distribution
              .participantId ===
            participantId
        );
    }

    if (requestId) {
      distributions =
        distributions.filter(
          (distribution) =>
            distribution
              .requestId ===
            requestId
        );
    }

    return enrichDistributions(distributions);
  };

// ========================================
// GET DISTRIBUTION BY ID
// ========================================

const getDistributionById =
  async (id) => {
    const doc =
      await distributionCollection
        .doc(id)
        .get();

    if (!doc.exists) {
      throw new Error(
        "Distribution record not found."
      );
    }

    const [enriched] = await enrichDistributions([
      {
        id:
          doc.id,

        ...doc.data(),
      },
    ]);

    return enriched;
  };

// ========================================
// GET DISTRIBUTIONS BY PARTICIPANT
// ========================================

const getDistributionsByParticipantId =
  async (
    participantId
  ) => {
    const snapshot =
      await distributionCollection
        .where(
          "participantId",
          "==",
          participantId
        )
        .get();

    return snapshot.docs.map(
      (doc) => ({
        id:
          doc.id,

        ...doc.data(),
      })
    );
  };

// Only the authenticated requester's own released distributions with something left to report.
// Sharing an event or a planting site never grants access to another requester's release.
const getEligibleDistributionsForParticipant = async (uid) => {
  if (typeof uid !== "string" || !uid) return [];
  const candidates = (await distributionCollection.where("participantId", "==", uid).get()).docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((distribution) => distribution.status === "Released" && distribution.eventId);
  const own = (await Promise.all(candidates.map(async (distribution) =>
    (isDistributionOwner(distribution, await loadDistributionRequest(db, distribution), uid) ? distribution : null)))).filter(Boolean);
  const read = async (collection, id) => {
    const doc = await db.collection(collection).doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  };
  const eventIds = [...new Set(own.map((distribution) => String(distribution.eventId)))];
  const [eventRows, parentRows] = await Promise.all([
    Promise.all(eventIds.map((id) => read("events", id))),
    Promise.all(eventIds.map((id) => read("plantingReports", `event_${id}`))),
  ]);
  const parents = new Map(eventIds.map((id, index) => [id, parentRows[index]]));

  const usableEvents = new Map(
    eventRows
      .filter((event) => {
        if (!event) return false;
        const recordStatus = String(event.recordStatus || "").trim().toLowerCase();
        const calendarStatus = String(event.status || "").trim().toLowerCase();
        const date = String(event.date || event.eventDate || event.startDate || "").slice(0, 10);
        const time = /^\d{2}:\d{2}/.test(String(event.startTime || ""))
          ? String(event.startTime).slice(0, 5) : "00:00";
        const startsAt = new Date(`${date}T${time}:00+08:00`);
        const unavailable = [recordStatus, calendarStatus].some((status) =>
          ["cancelled", "canceled", "rejected", "deleted", "archived"].includes(status));
        return event.archived !== true && !unavailable &&
          ["authorized", "scheduled", "approved", "completed"].includes(recordStatus) &&
          (Number.isNaN(startsAt.getTime()) || startsAt <= new Date());
      })
      .map((event) => [event.id, event])
  );
  return own
    .filter((distribution) => {
      const event = usableEvents.get(String(distribution.eventId || ""));
      if (!event || !event.allocationReleasedAt || !event.plantingSiteId) return false;
      if (!hasReportableBalance(event, parents.get(event.id))) return false;
      const eventRequestMatches = !event.sourceRequestId ||
        String(event.sourceRequestId) === String(distribution.requestId || distribution.id);
      return eventRequestMatches;
    })
    .map((distribution) => ({
      id: distribution.id,
      distributionNumber: distribution.distributionNumber || "",
      requestId: distribution.requestId || "",
      requestNumber: distribution.requestNumber || "",
      status: distribution.status,
      eventId: distribution.eventId || "",
      plantingSiteId: distribution.plantingSiteId || "",
      plantingLocation: distribution.plantingLocation || "",
      participantName: distribution.participantName || "",
      participantType: distribution.participantType || "",
      organization: distribution.organization || "",
      barangay: distribution.barangay || "",
      items: distribution.items || [],
      totalQuantityReleased: distribution.totalQuantityReleased || 0,
      quantityReleased: distribution.quantityReleased,
      inventoryId: distribution.inventoryId,
      species: distribution.species,
      releasedAt: distribution.releasedAt || null,
    }));
};

module.exports = {
  createDistributionRecordInTransaction,
  getAllDistributions,
  getDistributionById,
  getDistributionsByParticipantId,
  getEligibleDistributionsForParticipant,
};
