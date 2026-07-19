const siteService = require("../services/site.service");

const {

sendSuccess,

sendError

} = require("../utils/response.util");



// CREATE SITE
const createSite = async (req, res) => {

try{


const site = await siteService.createSite({


...req.body,


createdBy: req.user.uid


});


return sendSuccess(


res,


201,


"Site created",


site


);


}


catch(error){


console.error(error);


return sendError(


res,


500,


error.message


);


}


};



// GET ALL SITES
const getAllSites = async (req, res) => {

    try {

        const sites = await siteService.getAllSites();

        return sendSuccess(
            res,
            200,
            "Sites retrieved",
            sites
        );

    }

    catch (error) {

        console.error(error);

        return sendError(
            res,
            500,
            error.message
        );

    }

};


// GET SITE BY ID
const getSiteById = async (req, res) => {

    try {

        const site = await siteService.getSiteById(
            req.params.id
        );

        return sendSuccess(
            res,
            200,
            "Site retrieved",
            site
        );

    }

    catch (error) {

        console.error(error);

        return sendError(
            res,
            404,
            error.message
        );

    }

};



module.exports = {
createSite,
getAllSites,
getSiteById
};