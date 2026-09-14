const { db } = require("../config/firebase");

const EVENTS_COLLECTION = "events";
const EVENT_COUNTERS_COLLECTION = "eventCounters";

const EVENT_TYPES = [
  "Tree Planting",
  "Seedling Distribution",
  "Monitoring Activity",
  "Other MENRO Activity",
];

const RECORD_STATUSES = [
  "authorized",
  "scheduled",
  "approved",
  "completed",
];

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBarangay(value) {
  return cleanString(value).toLowerCase();
}

function validateEventType(type) {
  if (!EVENT_TYPES.includes(type)) {
    throw new Error("Invalid event type.");
  }
}

function validateRecordStatus(status) {
  if (!RECORD_STATUSES.includes(status)) {
    throw new Error("Invalid event record status.");
  }
}

function validateSchedule(date, startTime, endTime) {
  if (!date) {
    throw new Error("Event date is required.");
  }

  if (!startTime) {
    throw new Error("Start time is required.");
  }

  if (!endTime) {
    throw new Error("End time is required.");
  }

  if (endTime <= startTime) {
    throw new Error("End time must be later than start time.");
  }
}

function validateExpectedParticipants(value) {
  const expectedParticipants = Number(value);

  if (
    !Number.isInteger(expectedParticipants) ||
    expectedParticipants < 1
  ) {
    throw new Error(
      "Expected participants must be a whole number greater than 0."
    );
  }

  return expectedParticipants;
}

function validateActualParticipants(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return 0;
  }

  const actualParticipants = Number(value);

  if (
    !Number.isInteger(actualParticipants) ||
    actualParticipants < 0
  ) {
    throw new Error(
      "Actual participants must be a whole number of 0 or greater."
    );
  }

  return actualParticipants;
}

async function getActiveSite(siteId, barangay) {
  const cleanSiteId = cleanString(siteId);
  const cleanBarangay = cleanString(barangay);

  if (!cleanSiteId) {
    throw new Error("Planting site is required.");
  }

  if (!cleanBarangay) {
    throw new Error("Barangay is required.");
  }

  const siteDoc = await db
    .collection("sites")
    .doc(cleanSiteId)
    .get();

  if (!siteDoc.exists) {
    throw new Error("Planting site not found.");
  }

  const site = siteDoc.data();

  if (
    String(site.status || "")
      .trim()
      .toLowerCase() !== "active"
  ) {
    throw new Error("Selected planting site is not active.");
  }

  if (
    normalizeBarangay(site.barangay) !==
    normalizeBarangay(cleanBarangay)
  ) {
    throw new Error(
      "Selected planting site does not belong to the selected barangay."
    );
  }

  return site;
}

async function generateEventId(transaction) {
  const year = new Date().getFullYear();

  const counterRef = db
    .collection(EVENT_COUNTERS_COLLECTION)
    .doc(String(year));

  const counterDoc = await transaction.get(counterRef);

  const currentValue = counterDoc.exists
    ? Number(counterDoc.data()?.lastNumber || 0)
    : 0;

  const nextValue = currentValue + 1;

  const eventId =
    `EVT-${year}-${String(nextValue).padStart(3, "0")}`;

  transaction.set(
    counterRef,
    {
      year,
      lastNumber: nextValue,
      updatedAt: new Date(),
    },
    { merge: true }
  );

  return eventId;
}

// CREATE EVENT
const createEvent = async (data) => {
  const name = cleanString(data.name);
  const type = cleanString(data.type);
  const barangay = cleanString(data.barangay);
  const plantingSiteId = cleanString(
    data.plantingSiteId
  );

  const date = cleanString(data.date);
  const startTime = cleanString(data.startTime);
  const endTime = cleanString(data.endTime);

  if (!name) {
    throw new Error("Event name is required.");
  }

  if (!type) {
    throw new Error("Event type is required.");
  }

  if (!barangay) {
    throw new Error("Barangay is required.");
  }

  validateEventType(type);
  validateSchedule(date, startTime, endTime);

  const expectedParticipants =
    validateExpectedParticipants(
      data.expectedParticipants
    );

  const site = await getActiveSite(
    plantingSiteId,
    barangay
  );

  const now = new Date();

  const event = await db.runTransaction(
    async (transaction) => {
      const eventId =
        await generateEventId(transaction);

      const eventRef = db
        .collection(EVENTS_COLLECTION)
        .doc(eventId);

      const eventData = {
        id: eventId,
        eventId,

        name,
        type,

        barangay,

        plantingSiteId: site.siteId,
        plantingSiteName: site.siteName,

        location: cleanString(data.location),

        date,
        startTime,
        endTime,

        expectedParticipants,
        actualParticipants: 0,

        organizer: cleanString(data.organizer),
        description: cleanString(data.description),

        recordStatus: "scheduled",
        status: "Upcoming",

        archived: false,

        createdBy: data.createdBy,
        updatedBy: data.createdBy,

        createdAt: now,
        updatedAt: now,
      };

      transaction.set(eventRef, eventData);

      return eventData;
    }
  );

  return event;
};

// GET ACTIVE EVENTS
const getAllEvents = async () => {
  const snapshot = await db
    .collection(EVENTS_COLLECTION)
    .get();

  return snapshot.docs
    .map((doc) => doc.data())
    .filter((event) => event.archived !== true);
};

// GET ARCHIVED EVENTS
const getArchivedEvents = async () => {
  const snapshot = await db
    .collection(EVENTS_COLLECTION)
    .get();

  return snapshot.docs
    .map((doc) => doc.data())
    .filter((event) => event.archived === true);
};

// GET EVENT BY ID
const getEventById = async (eventId) => {
  const cleanEventId = cleanString(eventId);

  const eventDoc = await db
    .collection(EVENTS_COLLECTION)
    .doc(cleanEventId)
    .get();

  if (!eventDoc.exists) {
    throw new Error("Event not found.");
  }

  return eventDoc.data();
};

// UPDATE EVENT
const updateEvent = async (
  eventId,
  data,
  updatedBy
) => {
  const eventRef = db
    .collection(EVENTS_COLLECTION)
    .doc(cleanString(eventId));

  const existingDoc = await eventRef.get();

  if (!existingDoc.exists) {
    throw new Error("Event not found.");
  }

  const existing = existingDoc.data();

  const name =
    data.name !== undefined
      ? cleanString(data.name)
      : existing.name;

  const type =
    data.type !== undefined
      ? cleanString(data.type)
      : existing.type;

  const barangay =
    data.barangay !== undefined
      ? cleanString(data.barangay)
      : existing.barangay;

  const plantingSiteId =
    data.plantingSiteId !== undefined
      ? cleanString(data.plantingSiteId)
      : existing.plantingSiteId;

  const date =
    data.date !== undefined
      ? cleanString(data.date)
      : existing.date;

  const startTime =
    data.startTime !== undefined
      ? cleanString(data.startTime)
      : existing.startTime;

  const endTime =
    data.endTime !== undefined
      ? cleanString(data.endTime)
      : existing.endTime;

  if (!name) {
    throw new Error("Event name is required.");
  }

  validateEventType(type);
  validateSchedule(date, startTime, endTime);

  const site = await getActiveSite(
    plantingSiteId,
    barangay
  );

  const expectedParticipants =
    data.expectedParticipants !== undefined
      ? validateExpectedParticipants(
          data.expectedParticipants
        )
      : existing.expectedParticipants;

  const actualParticipants =
    data.actualParticipants !== undefined
      ? validateActualParticipants(
          data.actualParticipants
        )
      : existing.actualParticipants || 0;

  const updates = {
    name,
    type,

    barangay,

    plantingSiteId: site.siteId,
    plantingSiteName: site.siteName,

    location:
      data.location !== undefined
        ? cleanString(data.location)
        : existing.location || "",

    date,
    startTime,
    endTime,

    expectedParticipants,
    actualParticipants,

    organizer:
      data.organizer !== undefined
        ? cleanString(data.organizer)
        : existing.organizer || "",

    description:
      data.description !== undefined
        ? cleanString(data.description)
        : existing.description || "",

    updatedBy,
    updatedAt: new Date(),
  };

  await eventRef.update(updates);

  const updatedDoc = await eventRef.get();

  return updatedDoc.data();
};

// UPDATE RECORD STATUS
const updateRecordStatus = async (
  eventId,
  recordStatus,
  updatedBy
) => {
  const normalizedStatus = cleanString(
    recordStatus
  ).toLowerCase();

  validateRecordStatus(normalizedStatus);

  const eventRef = db
    .collection(EVENTS_COLLECTION)
    .doc(cleanString(eventId));

  const eventDoc = await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error("Event not found.");
  }

  const updates = {
    recordStatus: normalizedStatus,
    updatedBy,
    updatedAt: new Date(),
  };

  if (normalizedStatus === "completed") {
    updates.status = "Completed";
  }

  await eventRef.update(updates);

  const updatedDoc = await eventRef.get();

  return updatedDoc.data();
};

// MARK COMPLETED
const markEventCompleted = async (
  eventId,
  updatedBy
) => {
  const eventRef = db
    .collection(EVENTS_COLLECTION)
    .doc(cleanString(eventId));

  const eventDoc = await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error("Event not found.");
  }

  await eventRef.update({
    recordStatus: "completed",
    status: "Completed",
    updatedBy,
    updatedAt: new Date(),
  });

  const updatedDoc = await eventRef.get();

  return updatedDoc.data();
};

// CANCEL EVENT
const cancelEvent = async (
  eventId,
  updatedBy
) => {
  const eventRef = db
    .collection(EVENTS_COLLECTION)
    .doc(cleanString(eventId));

  const eventDoc = await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error("Event not found.");
  }

  await eventRef.update({
    status: "Cancelled",
    updatedBy,
    updatedAt: new Date(),
  });

  const updatedDoc = await eventRef.get();

  return updatedDoc.data();
};

// ARCHIVE EVENT
const archiveEvent = async (
  eventId,
  updatedBy
) => {
  const eventRef = db
    .collection(EVENTS_COLLECTION)
    .doc(cleanString(eventId));

  const eventDoc = await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error("Event not found.");
  }

  await eventRef.update({
    archived: true,
    archivedAt: new Date(),
    updatedBy,
    updatedAt: new Date(),
  });

  const updatedDoc = await eventRef.get();

  return updatedDoc.data();
};

// RESTORE EVENT
const restoreEvent = async (
  eventId,
  updatedBy
) => {
  const eventRef = db
    .collection(EVENTS_COLLECTION)
    .doc(cleanString(eventId));

  const eventDoc = await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error("Event not found.");
  }

  await eventRef.update({
    archived: false,
    archivedAt: null,
    updatedBy,
    updatedAt: new Date(),
  });

  const updatedDoc = await eventRef.get();

  return updatedDoc.data();
};

// DELETE EVENT
const deleteEvent = async (eventId) => {
  const eventRef = db
    .collection(EVENTS_COLLECTION)
    .doc(cleanString(eventId));

  const eventDoc = await eventRef.get();

  if (!eventDoc.exists) {
    throw new Error("Event not found.");
  }

  await eventRef.delete();

  return {
    id: eventId,
    eventId,
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
};