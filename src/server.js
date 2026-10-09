require("dotenv").config();

const {
  validateIdentificationEncryptionConfig,
} = require("./services/requestIdentification.service");

validateIdentificationEncryptionConfig();

const app = require("./app");

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(` Server running on port ${PORT}`);
});
