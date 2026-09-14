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

    locationDescription: cleanString(
      data.locationDescription
    ),

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
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
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
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
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

  return {
    id: doc.id,
    ...doc.data(),
  };
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

  return {
    id: updatedDoc.id,
    ...updatedDoc.data(),
  };
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

  return {
    id: updatedDoc.id,
    ...updatedDoc.data(),
  };
};

module.exports = {
  createSite,
  getAllSites,
  getArchivedSites,
  getSiteById,
  archiveSite,
  restoreSite,
};