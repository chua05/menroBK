const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const SITE_COLLECTION = "sites";

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateCoordinates(latitudeValue, longitudeValue) {
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);

  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new Error("Latitude must be between -90 and 90.");
  }

  if (
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error("Longitude must be between -180 and 180.");
  }

  return { latitude, longitude };
}

function normalizePolygon(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const polygon = value
    .map((point) => ({
      lat: Number(point?.lat),
      lng: Number(point?.lng),
    }))
    .filter(
      (point) =>
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lng) &&
        point.lat >= -90 &&
        point.lat <= 90 &&
        point.lng >= -180 &&
        point.lng <= 180
    );

  if (polygon.length < 3) {
    throw new Error(
      "Planting site boundary must contain at least three valid points."
    );
  }

  return polygon;
}

function computeUtilizationFields(siteData) {
  const maximumCapacity = Number(siteData.maximumCapacity || 0);
  const planted = Number(siteData.planted || 0);

  let availableCapacity = Math.max(0, maximumCapacity - planted);

  let utilizationPercentage = 0;

  if (maximumCapacity > 0) {
    utilizationPercentage = Math.round((planted / maximumCapacity) * 100);

    if (!Number.isFinite(utilizationPercentage)) {
      utilizationPercentage = 0;
    }

    if (utilizationPercentage < 0) utilizationPercentage = 0;
    if (utilizationPercentage > 100) utilizationPercentage = 100;
  }

  let utilizationStatus = "Available";

  if (utilizationPercentage >= 90) {
    utilizationStatus = "Full";
  } else if (utilizationPercentage >= 50) {
    utilizationStatus = "Partially Occupied";
  } else {
    utilizationStatus = "Available";
  }

  return {
    availableCapacity,
    utilizationPercentage,
    utilizationStatus,
  };
}

function formatSiteDocument(doc) {
  const data = doc.data ? doc.data() : doc;
  const base = {
    ...data,
    id: doc.id || data.siteId || data.id,
  };

  const util = computeUtilizationFields(base);

  return {
    ...base,
    availableCapacity: util.availableCapacity,
    utilizationPercentage: util.utilizationPercentage,
    utilizationStatus: util.utilizationStatus,
  };
}

// --------------------------------
// CREATE SITE
// --------------------------------
const createSite = async (data) => {
  const siteName = cleanString(data.siteName);
  const barangay = cleanString(data.barangay);
  const siteType = cleanString(data.siteType);

  if (!siteName) {
    throw new Error("Site name is required.");
  }

  if (!barangay) {
    throw new Error("Barangay is required.");
  }

  if (!siteType) {
    throw new Error("Site type is required.");
  }

  const locationDescription = cleanString(
    data.locationDescription
  );

  if (!locationDescription) {
    throw new Error("Location description is required.");
  }

  const areaHectares = Number(data.areaHectares);
  const maximumCapacity = Number(data.maximumCapacity);

  if (!Number.isFinite(areaHectares) || areaHectares <= 0) {
    throw new Error("Site area must be greater than 0.");
  }

  if (
    !Number.isInteger(maximumCapacity) ||
    maximumCapacity <= 0
  ) {
    throw new Error(
      "Maximum seedling capacity must be a whole number greater than 0."
    );
  }

  const { latitude, longitude } = validateCoordinates(
    data.latitude,
    data.longitude
  );

  const polygon = normalizePolygon(data.polygon);

  // Firestore/backend creates the Site ID.
  const siteRef = db.collection(SITE_COLLECTION).doc();

  const now = Timestamp.now();

  const site = {
    siteId: siteRef.id,

    siteName,
    barangay,

    municipality: "Juban",
    province: "Sorsogon",

    siteType,

    areaHectares,
    maximumCapacity,

    // Compatibility with existing site/inventory logic.
    targetTrees: maximumCapacity,

    planted: 0,

    latitude,
    longitude,

    polygon,

    locationDescription,

    // keep compatibility: already have `locationDescription` above

    ownershipType: cleanString(
      data.ownershipType
    ),

    coordinator: cleanString(
      data.coordinator
    ),

    coordinatorContact: cleanString(
      data.coordinatorContact
    ),

    notes: cleanString(data.notes),

    treeCondition: "Not Yet Monitored",

    survivalRate: null,
    treeAgeMonths: null,

    relatedEventId: "",
    relatedEventName: "",

    growthDocumentation: [],

    createdBy: data.createdBy,
    updatedBy: data.createdBy,

    status: "active",

    archivedAt: null,

    createdAt: now,
    updatedAt: now,
  };

  await siteRef.set(site);

  return {
    id: siteRef.id,
    ...site,
  };
};

// --------------------------------
// GET ALL ACTIVE SITES
// --------------------------------
const getAllSites = async () => {
  const snapshot = await db
    .collection(SITE_COLLECTION)
    .get();
  return snapshot.docs
    .map((doc) => formatSiteDocument(doc))
    .filter(
      (site) =>
        String(site.status || "active")
          .trim()
          .toLowerCase() !== "archived"
    );
};

// --------------------------------
// GET ARCHIVED SITES
// --------------------------------
const getArchivedSites = async () => {
  const snapshot = await db
    .collection(SITE_COLLECTION)
    .get();
  return snapshot.docs
    .map((doc) => formatSiteDocument(doc))
    .filter(
      (site) =>
        String(site.status || "")
          .trim()
          .toLowerCase() === "archived"
    );
};

// --------------------------------
// GET SITE BY ID
// --------------------------------
const getSiteById = async (siteId) => {
  const doc = await db
    .collection(SITE_COLLECTION)
    .doc(siteId)
    .get();

  if (!doc.exists) {
    throw new Error("Site not found.");
  }

  return formatSiteDocument(doc);
};

// Edit the same site document while preserving workflow and audit fields.
const updateSite = async (siteId, input, updatedBy) => {
  const siteRef = db.collection(SITE_COLLECTION).doc(siteId);
  const existing = await siteRef.get();
  if (!existing.exists) throw new Error("Site not found.");

  const changes = {};
  const requiredStrings = ["siteName", "barangay", "siteType", "locationDescription"];
  const optionalStrings = ["ownershipType", "coordinator", "coordinatorContact", "notes"];
  for (const field of requiredStrings) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field)) {
      const value = cleanString(input[field]);
      if (!value) throw new Error(`${field} is required.`);
      changes[field] = value;
    }
  }
  for (const field of optionalStrings) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field)) {
      changes[field] = cleanString(input[field]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "areaHectares")) {
    const area = Number(input.areaHectares);
    if (!Number.isFinite(area) || area <= 0) throw new Error("Site area must be greater than 0.");
    changes.areaHectares = area;
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "maximumCapacity")) {
    const capacity = Number(input.maximumCapacity);
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("Maximum seedling capacity must be a whole number greater than 0.");
    }
    if (capacity < Number(existing.data().planted || 0)) {
      throw new Error("Maximum seedling capacity cannot be below the planted count.");
    }
    changes.maximumCapacity = capacity;
    changes.targetTrees = capacity;
  }
  if (["latitude", "longitude"].some((field) => Object.prototype.hasOwnProperty.call(input || {}, field))) {
    const latitude = Object.prototype.hasOwnProperty.call(input, "latitude") ? input.latitude : existing.data().latitude;
    const longitude = Object.prototype.hasOwnProperty.call(input, "longitude") ? input.longitude : existing.data().longitude;
    if (latitude === null || latitude === "" || longitude === null || longitude === "") {
      throw new Error("Valid site coordinates are required.");
    }
    Object.assign(changes, validateCoordinates(latitude, longitude));
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "polygon")) {
    if (!Array.isArray(input.polygon)) throw new Error("A valid planting site boundary is required.");
    changes.polygon = normalizePolygon(input.polygon);
  }
  if (!Object.keys(changes).length) throw new Error("No editable site fields provided.");

  await siteRef.update({ ...changes, updatedBy, updatedAt: Timestamp.now() });
  return formatSiteDocument(await siteRef.get());
};

// --------------------------------
// ARCHIVE SITE
// --------------------------------
const archiveSite = async (
  siteId,
  updatedBy
) => {
  const siteRef = db
    .collection(SITE_COLLECTION)
    .doc(siteId);

  const siteDoc = await siteRef.get();

  if (!siteDoc.exists) {
    throw new Error("Site not found.");
  }

  const now = Timestamp.now();

  await siteRef.update({
    status: "archived",

    archivedAt: now,

    updatedBy,

    updatedAt: now,
  });

  const updatedDoc = await siteRef.get();
  return formatSiteDocument(updatedDoc);
};

// --------------------------------
// RESTORE SITE
// --------------------------------
const restoreSite = async (
  siteId,
  updatedBy
) => {
  const siteRef = db
    .collection(SITE_COLLECTION)
    .doc(siteId);

  const siteDoc = await siteRef.get();

  if (!siteDoc.exists) {
    throw new Error("Site not found.");
  }

  const now = Timestamp.now();

  await siteRef.update({
    status: "active",

    archivedAt: null,

    updatedBy,

    updatedAt: now,
  });

  const updatedDoc = await siteRef.get();
  return formatSiteDocument(updatedDoc);
};

module.exports = {
  createSite,
  getAllSites,
  getArchivedSites,
  getSiteById,
  updateSite,
  archiveSite,
  restoreSite,
};
