const {
  db,
} = require("../config/firebase");

const EVENTS_COLLECTION =
  "events";

const EVENT_COUNTERS_COLLECTION =
  "eventCounters";

// ========================================
// EVENT TYPES
//
// Calendar is for actual MENRO events only.
//
// Seedling Distribution is NOT an event.
// Monitoring records are NOT calendar events.
// ========================================

const EVENT_TYPES = [
  "Tree Planting",
  "Other MENRO Activity",
];

const RECORD_STATUSES = [
  "scheduled",
  "completed",
];

// ========================================
// BASIC HELPERS
// ========================================

function cleanString(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
}

function normalizeBarangay(value) {
  return cleanString(
    value
  ).toLowerCase();
}

function validateEventType(type) {
  if (
    !EVENT_TYPES.includes(type)
  ) {
    throw new Error(
      "Invalid event type."
    );
  }
}

function validateRecordStatus(
  status
) {
  if (
    !RECORD_STATUSES.includes(
      status
    )
  ) {
    throw new Error(
      "Invalid event record status."
    );
  }
}

function validateSchedule(
  date,
  startTime,
  endTime
) {
  if (!date) {
    throw new Error(
      "Event date is required."
    );
  }

  if (!startTime) {
    throw new Error(
      "Start time is required."
    );
  }

  if (!endTime) {
    throw new Error(
      "End time is required."
    );
  }

  if (endTime <= startTime) {
    throw new Error(
      "End time must be later than start time."
    );
  }
}

function validateExpectedParticipants(
  value
) {
  const expectedParticipants =
    Number(value);

  if (
    !Number.isInteger(
      expectedParticipants
    ) ||
    expectedParticipants < 0
  ) {
    throw new Error(
      "Expected participants must be a whole number of 0 or greater."
    );
  }

  return expectedParticipants;
}

function validateActualParticipants(
  value
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return 0;
  }

  const actualParticipants =
    Number(value);

  if (
    !Number.isInteger(
      actualParticipants
    ) ||
    actualParticipants < 0
  ) {
    throw new Error(
      "Actual participants must be a whole number of 0 or greater."
    );
  }

  return actualParticipants;
}

// ========================================
// SEEDLING ITEM HELPERS
//
// Supports:
// 1. New multi-item requests using items[]
// 2. Old single-item request records
// ========================================

function normalizeSeedlingItems(
  requestData,
  inventoryData = null
) {
  if (
    Array.isArray(
      requestData?.items
    ) &&
    requestData.items.length > 0
  ) {
    return requestData.items.map(
      (item) => ({
        inventoryId:
          cleanString(
            item.inventoryId
          ),

        species:
          cleanString(
            item.species
          ),

        scientificName:
          cleanString(
            item.scientificName
          ),

        category:
          cleanString(
            item.category
          ),

        quantity:
          Number(
            item.quantity || 0
          ),
      })
    );
  }

  // ========================================
  // BACKWARD COMPATIBILITY
  //
  // Old requests used:
  // inventoryId
  // species
  // scientificName
  // quantity
  // ========================================

  const inventoryId =
    cleanString(
      requestData?.inventoryId
    );

  if (!inventoryId) {
    return [];
  }

  return [
    {
      inventoryId,

      species:
        cleanString(
          inventoryData?.species ||
            requestData?.species
        ),

      scientificName:
        cleanString(
          inventoryData
            ?.scientificName ||
            requestData
              ?.scientificName
        ),

      category:
        cleanString(
          inventoryData?.category ||
            requestData?.category
        ),

      quantity:
        Number(
          requestData?.quantity ||
            0
        ),
    },
  ];
}

// ========================================
// VALIDATE EVENT SEEDLING ITEMS
// ========================================

function validateSeedlingItems(
  items
) {
  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    throw new Error(
      "Tree Planting event has no seedling allocation."
    );
  }

  const inventoryIds =
    new Set();

  for (const item of items) {
    if (
      !cleanString(
        item.inventoryId
      )
    ) {
      throw new Error(
        "A seedling allocation has no linked inventory."
      );
    }

    const quantity =
      Number(
        item.quantity
      );

    if (
      !Number.isInteger(
        quantity
      ) ||
      quantity <= 0
    ) {
      throw new Error(
        "Seedling allocation quantity must be a positive whole number."
      );
    }

    if (
      inventoryIds.has(
        item.inventoryId
      )
    ) {
      throw new Error(
        "The same seedling inventory cannot appear more than once in the event allocation."
      );
    }

    inventoryIds.add(
      item.inventoryId
    );
  }
}

// ========================================
// GET ACTIVE PLANTING SITE
// ========================================

async function getActiveSite(
  siteId,
  barangay
) {
  const cleanSiteId =
    cleanString(siteId);

  const cleanBarangay =
    cleanString(barangay);

  if (!cleanSiteId) {
    throw new Error(
      "Planting site is required."
    );
  }

  if (!cleanBarangay) {
    throw new Error(
      "Barangay is required."
    );
  }

  const siteDoc =
    await db
      .collection("sites")
      .doc(cleanSiteId)
      .get();

  if (!siteDoc.exists) {
    throw new Error(
      "Planting site not found."
    );
  }

  const site =
    siteDoc.data();

  if (
    String(
      site.status || ""
    )
      .trim()
      .toLowerCase() !==
    "active"
  ) {
    throw new Error(
      "Selected planting site is not active."
    );
  }

  if (
    normalizeBarangay(
      site.barangay
    ) !==
    normalizeBarangay(
      cleanBarangay
    )
  ) {
    throw new Error(
      "Selected planting site does not belong to the selected barangay."
    );
  }

  return site;
}

// ========================================
// GENERATE EVENT ID
// ========================================

async function generateEventId(
  transaction
) {
  const year =
    new Date().getFullYear();

  const counterRef =
    db
      .collection(
        EVENT_COUNTERS_COLLECTION
      )
      .doc(String(year));

  const counterDoc =
    await transaction.get(
      counterRef
    );

  const currentValue =
    counterDoc.exists
      ? Number(
          counterDoc.data()
            ?.lastNumber || 0
        )
      : 0;

  const nextValue =
    currentValue + 1;

  const eventId =
    `EVT-${year}-${String(
      nextValue
    ).padStart(3, "0")}`;

  transaction.set(
    counterRef,
    {
      year,

      lastNumber:
        nextValue,

      updatedAt:
        new Date(),
    },
    {
      merge: true,
    }
  );

  return eventId;
}

// ========================================
// CREATE EVENT
//
// STAFF / ADMIN MANUAL EVENT CREATION
// ========================================

const createEvent = async (
  data
) => {
  const name =
    cleanString(data.name);

  const type =
    cleanString(data.type);

  const barangay =
    cleanString(
      data.barangay
    );

  const plantingSiteId =
    cleanString(
      data.plantingSiteId
    );

  const date =
    cleanString(data.date);

  const startTime =
    cleanString(
      data.startTime
    );

  const endTime =
    cleanString(
      data.endTime
    );

  if (!name) {
    throw new Error(
      "Event name is required."
    );
  }

  if (!type) {
    throw new Error(
      "Event type is required."
    );
  }

  if (!barangay) {
    throw new Error(
      "Barangay is required."
    );
  }

  validateEventType(type);

  validateSchedule(
    date,
    startTime,
    endTime
  );

  const expectedParticipants =
    validateExpectedParticipants(
      data.expectedParticipants
    );

  const site =
    await getActiveSite(
      plantingSiteId,
      barangay
    );

  const now =
    new Date();

  const event =
    await db.runTransaction(
      async (transaction) => {
        const eventId =
          await generateEventId(
            transaction
          );

        const eventRef =
          db
            .collection(
              EVENTS_COLLECTION
            )
            .doc(eventId);

        const eventData = {
          id:
            eventId,

          eventId,

          name,

          type,

          barangay,

          plantingSiteId:
            plantingSiteId,

          plantingSiteName:
            site.siteName || "",

          location:
            cleanString(
              data.location
            ),

          date,

          startTime,

          endTime,

          expectedParticipants,

          actualParticipants:
            0,

          organizer:
            cleanString(
              data.organizer
            ),

          description:
            cleanString(
              data.description
            ),

          // ========================================
          // SCHEDULE STATUS
          //
          // Manual event already has complete
          // date/time/site information.
          // ========================================

          recordStatus:
            "scheduled",

          status:
            "Upcoming",

          archived:
            false,

          // ========================================
          // SOURCE
          // ========================================

          source:
            "manual",

          sourceRequestId:
            "",

          // ========================================
          // SEEDLING ALLOCATION
          //
          // Manual events do not automatically
          // receive a seedling allocation.
          // ========================================

          seedlingItems:
            [],

          seedlingTotalQuantity:
            0,

          // Legacy fields retained for
          // compatibility with existing code.
          seedlingInventoryId:
            "",

          seedlingSpecies:
            "",

          seedlingQuantity:
            0,

          createdBy:
            data.createdBy,

          updatedBy:
            data.createdBy,

          createdAt:
            now,

          updatedAt:
            now,
        };

        transaction.set(
          eventRef,
          eventData
        );

        return eventData;
      }
    );

  return event;
};

// ========================================
// CREATE TREE PLANTING EVENT
// FROM APPROVED SEEDLING REQUEST
//
// IMPORTANT:
//
// This runs inside the SAME Firestore
// transaction as request approval.
//
// Admin approval means the proposed
// Tree Planting event is immediately
// SCHEDULED.
//
// The proposal already contains:
// - date
// - time
// - barangay
// - planting site
// - location
//
// There is NO separate authorization
// or scheduling step.
// ========================================

const createTreePlantingEventInTransaction =
  async (
    transaction,
    {
      requestId,
      requestData,
      inventoryData,
      approvedBy,
      approvedAt,
      siteData,
    }
  ) => {
    const proposal =
      requestData.eventProposal ||
      {};

    const eventName =
      cleanString(
        proposal.eventName
      );

    const barangay =
      cleanString(
        proposal.barangay
      );

    const plantingSiteId =
      cleanString(
        proposal.plantingSiteId
      );

    const date =
      cleanString(
        proposal.proposedDate
      );

    const startTime =
      cleanString(
        proposal.proposedStartTime
      );

    const endTime =
      cleanString(
        proposal.proposedEndTime
      );

    // ========================================
    // EVENT VALIDATION
    // ========================================

    if (!eventName) {
      throw new Error(
        "Planting event name is required."
      );
    }

    if (!barangay) {
      throw new Error(
        "Planting event barangay is required."
      );
    }

    if (!plantingSiteId) {
      throw new Error(
        "Planting site is required before the request can be approved."
      );
    }

    validateSchedule(
      date,
      startTime,
      endTime
    );

    const expectedParticipants =
      validateExpectedParticipants(proposal.expectedParticipants ?? 0);

    // ========================================
    // SEEDLING ALLOCATION
    // ========================================

    const seedlingItems =
      normalizeSeedlingItems(
        requestData,
        inventoryData
      );

    validateSeedlingItems(
      seedlingItems
    );

    const seedlingTotalQuantity =
      seedlingItems.reduce(
        (
          total,
          item
        ) =>
          total +
          Number(
            item.quantity ||
              0
          ),
        0
      );

    if (
      seedlingTotalQuantity <= 0
    ) {
      throw new Error(
        "Tree Planting event must have a valid seedling allocation."
      );
    }

    // ========================================
    // LEGACY PRIMARY SEEDLING
    //
    // Keep these fields temporarily so any
    // older Event Calendar code that expects
    // one species does not immediately break.
    //
    // New code should use seedlingItems[].
    // ========================================

    const primarySeedling =
      seedlingItems[0];

    const eventId =
      await generateEventId(
        transaction
      );

    const eventRef =
      db
        .collection(
          EVENTS_COLLECTION
        )
        .doc(eventId);

    const eventData = {
      id:
        eventId,

      eventId,

      name:
        eventName,

      type:
        "Tree Planting",

      barangay,

      plantingSiteId,

      plantingSiteName:
        cleanString(
          siteData?.siteName
        ),

      location:
        cleanString(
          proposal.eventLocation ||
            requestData
              .plantingLocation
        ),

      latitude:
        Number(
          proposal.latitude
        ),

      longitude:
        Number(
          proposal.longitude
        ),

      date,

      startTime,

      endTime,

      expectedParticipants,

      actualParticipants:
        0,

      organizer:
        "MENRO Juban",

      description:
        cleanString(
          proposal.description
        ),

      // ========================================
      // APPROVAL = AUTHORIZED + SCHEDULED
      //
      // We keep "scheduled" as the canonical
      // recordStatus because there is no
      // separate scheduling step.
      // ========================================

      recordStatus:
        "scheduled",

      status:
        "Upcoming",

      archived:
        false,

      // ========================================
      // SOURCE LINK
      // ========================================

      source:
        "seedling_request",

      sourceRequestId:
        requestId,

      sourceRequestNumber:
        requestData.requestNumber || "",

      // ========================================
      // MULTI-SEEDLING ALLOCATION
      //
      // This is the canonical structure for
      // approved seedling-request events.
      // ========================================

      requestedSeedlingItems: seedlingItems,
      seedlingItems: [],
      seedlingTotalQuantity: 0,

      // ========================================
      // PLANTING CONTRIBUTION COUNTERS
      //
      // No participant contribution has been
      // recorded yet at event creation.
      // ========================================

      recordedSeedlingQuantity:
        0,

      remainingSeedlingQuantity:
        0,

      // ========================================
      // LEGACY SINGLE-SEEDLING FIELDS
      //
      // Retained for compatibility.
      // ========================================

      seedlingInventoryId:
        primarySeedling
          .inventoryId,

      seedlingSpecies:
        primarySeedling
          .species,

      // For multi-tree events, this legacy
      // field represents TOTAL allocation.
      seedlingQuantity:
        0,

      createdBy:
        approvedBy,

      updatedBy:
        approvedBy,

      createdAt:
        approvedAt,

      updatedAt:
        approvedAt,
    };

    transaction.set(
      eventRef,
      eventData
    );

    return {
      eventId,
      eventData,
    };
  };

// ========================================
// GET ACTIVE EVENTS
// ========================================

const getAllEvents =
  async () => {
    const [snapshot, participantSnapshot, requestSnapshot] = await Promise.all([
      db.collection(EVENTS_COLLECTION).get(),
      db.collection("eventParticipants").get(),
      db.collection("seedlingRequests").get(),
    ]);

    const participantCounts = new Map();
    participantSnapshot.docs.forEach((doc) => {
      const eventId = doc.data().eventId;
      participantCounts.set(eventId, (participantCounts.get(eventId) || 0) + 1);
    });
    const requestNumbers = new Map(requestSnapshot.docs.map((doc) => [doc.id, doc.data().requestNumber || ""]));

    return snapshot.docs
      .map(
        (doc) => {
          const event = doc.data();
          return {
            id: doc.id,
            ...event,
            actualParticipants: participantCounts.get(doc.id) || 0,
            sourceRequestNumber: event.sourceRequestNumber || requestNumbers.get(event.sourceRequestId) || "",
          };
        }
      )
      .filter(
        (event) =>
          event.archived !==
          true
      );
  };

// ========================================
// GET ARCHIVED EVENTS
// ========================================

const getArchivedEvents =
  async () => {
    const snapshot =
      await db
        .collection(
          EVENTS_COLLECTION
        )
        .get();

    return snapshot.docs
      .map(
        (doc) => ({ id: doc.id, ...doc.data() })
      )
      .filter(
        (event) =>
          event.archived ===
          true
      );
  };

// ========================================
// GET EVENT BY ID
// ========================================

const getEventById =
  async (eventId) => {
    const cleanEventId =
      cleanString(eventId);

    const eventDoc =
      await db
        .collection(
          EVENTS_COLLECTION
        )
        .doc(cleanEventId)
        .get();

    if (!eventDoc.exists) {
      throw new Error(
        "Event not found."
      );
    }

    const event = eventDoc.data();
    const [participants, requestDoc] = await Promise.all([
      db.collection("eventParticipants").where("eventId", "==", cleanEventId).get(),
      event.sourceRequestId
        ? db.collection("seedlingRequests").doc(event.sourceRequestId).get()
        : Promise.resolve(null),
    ]);
    return {
      id: eventDoc.id,
      ...event,
      actualParticipants: participants.size,
      sourceRequestNumber: event.sourceRequestNumber || (requestDoc?.exists ? requestDoc.data().requestNumber || "" : ""),
    };
  };

// ========================================
// UPDATE EVENT
// ========================================

const updateEvent = async (
  eventId,
  data,
  updatedBy
) => {
  const eventRef =
    db
      .collection(
        EVENTS_COLLECTION
      )
      .doc(
        cleanString(
          eventId
        )
      );

  const existingDoc =
    await eventRef.get();

  if (!existingDoc.exists) {
    throw new Error(
      "Event not found."
    );
  }

  const existing =
    existingDoc.data();

  const name =
    data.name !== undefined
      ? cleanString(
          data.name
        )
      : existing.name;

  const type =
    data.type !== undefined
      ? cleanString(
          data.type
        )
      : existing.type;

  const barangay =
    data.barangay !==
    undefined
      ? cleanString(
          data.barangay
        )
      : existing.barangay;

  const plantingSiteId =
    data.plantingSiteId !==
    undefined
      ? cleanString(
          data.plantingSiteId
        )
      : existing
          .plantingSiteId;

  const date =
    data.date !== undefined
      ? cleanString(
          data.date
        )
      : existing.date;

  const startTime =
    data.startTime !==
    undefined
      ? cleanString(
          data.startTime
        )
      : existing.startTime;

  const endTime =
    data.endTime !==
    undefined
      ? cleanString(
          data.endTime
        )
      : existing.endTime;

  if (!name) {
    throw new Error(
      "Event name is required."
    );
  }

  validateEventType(type);

  validateSchedule(
    date,
    startTime,
    endTime
  );

  const site =
    await getActiveSite(
      plantingSiteId,
      barangay
    );

  const expectedParticipants =
    data.expectedParticipants !==
    undefined
      ? validateExpectedParticipants(
          data.expectedParticipants
        )
      : existing
          .expectedParticipants;

  const actualParticipants =
    data.actualParticipants !==
    undefined
      ? validateActualParticipants(
          data.actualParticipants
        )
      : existing
          .actualParticipants ||
        0;

  const updates = {
    name,

    type,

    barangay,

    plantingSiteId:
      plantingSiteId,

    plantingSiteName:
      site.siteName || "",

    location:
      data.location !==
      undefined
        ? cleanString(
            data.location
          )
        : existing.location ||
          "",

    date,

    startTime,

    endTime,

    expectedParticipants,

    actualParticipants,

    organizer:
      data.organizer !==
      undefined
        ? cleanString(
            data.organizer
          )
        : existing.organizer ||
          "",

    description:
      data.description !==
      undefined
        ? cleanString(
            data.description
          )
        : existing.description ||
          "",

    updatedBy,

    updatedAt:
      new Date(),
  };

  await eventRef.update(
    updates
  );

  const updatedDoc =
    await eventRef.get();

  return updatedDoc.data();
};

// ========================================
// UPDATE RECORD STATUS
// ========================================

const updateRecordStatus =
  async (
    eventId,
    recordStatus,
    updatedBy
  ) => {
    const normalizedStatus =
      cleanString(
        recordStatus
      ).toLowerCase();

    validateRecordStatus(
      normalizedStatus
    );

    const eventRef =
      db
        .collection(
          EVENTS_COLLECTION
        )
        .doc(
          cleanString(
            eventId
          )
        );

    const eventDoc =
      await eventRef.get();

    if (!eventDoc.exists) {
      throw new Error(
        "Event not found."
      );
    }

    const updates = {
      recordStatus:
        normalizedStatus,

      updatedBy,

      updatedAt:
        new Date(),
    };

    if (
      normalizedStatus ===
      "completed"
    ) {
      updates.status =
        "Completed";
    }

    await eventRef.update(
      updates
    );

    const updatedDoc =
      await eventRef.get();

    return updatedDoc.data();
  };

// ========================================
// MARK COMPLETED
// ========================================

const markEventCompleted =
  async (
    eventId,
    updatedBy
  ) => {
    const eventRef =
      db
        .collection(
          EVENTS_COLLECTION
        )
        .doc(
          cleanString(
            eventId
          )
        );

    const eventDoc =
      await eventRef.get();

    if (!eventDoc.exists) {
      throw new Error(
        "Event not found."
      );
    }

    await eventRef.update({
      recordStatus:
        "completed",

      status:
        "Completed",

      updatedBy,

      updatedAt:
        new Date(),
    });

    const updatedDoc =
      await eventRef.get();

    return updatedDoc.data();
  };

// ========================================
// CANCEL EVENT
// ========================================

const cancelEvent = async (
  eventId,
  updatedBy
) => {
  const eventRef =
    db
      .collection(
        EVENTS_COLLECTION
      )
      .doc(
        cleanString(
          eventId
        )
      );

  const eventDoc =
    await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error(
      "Event not found."
    );
  }

  await eventRef.update({
    status:
      "Cancelled",

    updatedBy,

    updatedAt:
      new Date(),
  });

  const updatedDoc =
    await eventRef.get();

  return updatedDoc.data();
};

// ========================================
// ARCHIVE EVENT
// ========================================

const archiveEvent = async (
  eventId,
  updatedBy
) => {
  const eventRef =
    db
      .collection(
        EVENTS_COLLECTION
      )
      .doc(
        cleanString(
          eventId
        )
      );

  const eventDoc =
    await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error(
      "Event not found."
    );
  }

  await eventRef.update({
    archived:
      true,

    archivedAt:
      new Date(),

    updatedBy,

    updatedAt:
      new Date(),
  });

  const updatedDoc =
    await eventRef.get();

  return updatedDoc.data();
};

// ========================================
// RESTORE EVENT
// ========================================

const restoreEvent = async (
  eventId,
  updatedBy
) => {
  const eventRef =
    db
      .collection(
        EVENTS_COLLECTION
      )
      .doc(
        cleanString(
          eventId
        )
      );

  const eventDoc =
    await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error(
      "Event not found."
    );
  }

  await eventRef.update({
    archived:
      false,

    archivedAt:
      null,

    updatedBy,

    updatedAt:
      new Date(),
  });

  const updatedDoc =
    await eventRef.get();

  return updatedDoc.data();
};

// ========================================
// DELETE EVENT
// ========================================

const deleteEvent =
  async (eventId) => {
    const cleanEventId =
      cleanString(
        eventId
      );

    const eventRef =
      db
        .collection(
          EVENTS_COLLECTION
        )
        .doc(cleanEventId);

    const eventDoc =
      await eventRef.get();

    if (!eventDoc.exists) {
      throw new Error(
        "Event not found."
      );
    }

    await eventRef.delete();

    return {
      id:
        cleanEventId,

      eventId:
        cleanEventId,
    };
  };

module.exports = {
  createEvent,
  getAllEvents,
  getArchivedEvents,
  getEventById,
  updateEvent,
  updateRecordStatus,
  markEventCompleted,
  cancelEvent,
  archiveEvent,
  restoreEvent,
  deleteEvent,

  // Used by seedling request approval.
  createTreePlantingEventInTransaction,
};
