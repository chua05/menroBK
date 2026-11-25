const {
  db,
} = require("../config/firebase");

const { isDistributionOwner, loadDistributionRequest } = require("../utils/distributionOwnership.util");
const { hasReportableBalance } = require("../utils/plantingBalance.util");

const COLLECTION =
  "distributions";

const distributionCollection =
  db.collection(COLLECTION);

// ========================================
// HELPER — NORMALIZE REQUEST ITEMS
// ========================================

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

    return distributions;
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

    return {
      id:
        doc.id,

      ...doc.data(),
    };
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
