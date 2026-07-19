const { sendError } = require("../utils/response.util");

const authorizeRoles = (...roles) => {

    return (req,res,next)=>{


        if(!req.user){

            return sendError(

                res,

                401,

                "Unauthorized"

            );

        }



        if(

            !roles.includes(

                req.user.role

            )

        ){

            return sendError(

                res,

                403,

                "Forbidden"

            );

        }


        next();


    };


};



module.exports={

authorizeRoles

};