const { db } = require("../config/firebase");


// CREATE SITE
const createSite = async (data) => {

    const siteRef = db.collection("sites").doc();

    const site = {

        siteId: siteRef.id,

        siteName: data.siteName,

        barangay: data.barangay,

        municipality: data.municipality,

        province: data.province,

        latitude: data.latitude,

        longitude: data.longitude,

        areaHectares: data.areaHectares,

        targetTrees: data.targetTrees,

        description: data.description || "",

        createdBy: data.createdBy,

        status: "active",

        createdAt: new Date(),

        updatedAt: new Date()

    };


    await siteRef.set(site);


    return site;

};


// GET ALL SITES
const getAllSites = async () => {

    const snapshot = await db
        .collection("sites")
        .get();

    const sites = snapshot.docs.map(doc => doc.data());

    return sites;

};


// GET SITE BY ID
const getSiteById = async (siteId) => {

    const doc = await db
        .collection("sites")
        .doc(siteId)
        .get();

    if (!doc.exists) {
        throw new Error("Site not found");
    }

    return doc.data();

};


module.exports = {

    createSite,
    getAllSites,
    getSiteById

};