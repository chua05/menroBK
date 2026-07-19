const express = require("express");

const router = express.Router();



const {

createSite,
getAllSites,
getSiteById

} = require("../controller/site.controller");



const {

verifyToken

} = require("../middleware/auth.middleware");



const {

authorizeRoles

} = require("../middleware/role.middleware");




// CREATE SITE
router.post(
    "/",
    verifyToken,
    authorizeRoles("admin", "staff"),
    createSite
);

router.get(
    "/",
    verifyToken,
    getAllSites
);

router.get(
    "/:id",
    verifyToken,
    getSiteById
);



module.exports = router;