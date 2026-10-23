const crypto = require("crypto");
const { db } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");

const IDENTIFICATION_COLLECTION = "requestIdentifications";
const ACCESS_LOG_COLLECTION = "sensitiveDataAccessLogs";
const LEGACY_KEY_ID = "legacy-v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const IDENTIFICATION_TYPES = Object.freeze({
  national_id: "National ID (PhilID / ePhilID / Digital National ID)",
  passport: "Philippine Passport",
  drivers_license: "Driver's License",
  prc: "PRC ID",
  umid_sss: "UMID / SSS ID",
  gsis: "GSIS ID / eCard",
  philhealth: "PhilHealth ID",
  tin: "TIN ID",
  postal: "Postal ID",
  voter: "Voter's ID / Voter's Certification",
  senior_citizen: "Senior Citizen ID",
  pwd: "PWD ID",
  solo_parent: "Solo Parent ID",
  owwa: "OWWA ID / eCard",
  seafarer: "Seafarer's ID / Seafarer's Record Book / SID",
  school_id: "School ID / Student ID",
});

const SAFE_ID_PATTERN = /^[A-Za-z0-9 /-]+$/;
const ALLOWED_INPUT_FIELDS = new Set([
  "identificationType",
  "idNumber",
  "schoolInstitutionName",
  "confirmed",
]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateIdentificationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Identification information is required.");
  }
  const unexpected = Object.keys(input).filter((key) => !ALLOWED_INPUT_FIELDS.has(key));
  if (unexpected.length > 0) {
    throw new Error("Unsupported identification information was provided.");
  }

  const identificationType = clean(input.identificationType);
  if (!Object.hasOwn(IDENTIFICATION_TYPES, identificationType)) {
    throw new Error("Identification Type is required.");
  }
  if (typeof input.idNumber !== "string") {
    throw new Error("ID Number is required.");
  }
  const idNumber = input.idNumber.trim();
  const minimumLength = identificationType === "school_id" ? 2 : 4;
  const maximumLength = identificationType === "school_id" ? 50 : 40;
  if (idNumber.length < minimumLength || idNumber.length > maximumLength) {
    throw new Error(`ID Number must be between ${minimumLength} and ${maximumLength} characters.`);
  }
  if (!SAFE_ID_PATTERN.test(idNumber)) {
    throw new Error("ID Number contains unsupported characters.");
  }

  const schoolInstitutionName = clean(input.schoolInstitutionName);
  if (identificationType === "school_id" && !schoolInstitutionName) {
    throw new Error("School / Institution Name is required.");
  }
  if (schoolInstitutionName.length > 120 || /[\u0000-\u001F\u007F]/.test(schoolInstitutionName)) {
    throw new Error("School / Institution Name is invalid.");
  }
  if (input.confirmed !== true) {
    throw new Error("Please confirm that the information provided is correct.");
  }

  return {
    identificationType,
    idNumber,
    ...(identificationType === "school_id" ? { schoolInstitutionName } : {}),
  };
}

function invalidEncryptionConfig(message) {
  const error = new Error(message);
  error.code = "IDENTIFICATION_ENCRYPTION_NOT_CONFIGURED";
  return error;
}

function decodeEncryptionKey(encoded, variableName) {
  const value = clean(encoded);
  const key = Buffer.from(value, "base64");
  const isCanonicalBase64 = /^[A-Za-z0-9+/]{43}=$/.test(value) &&
    key.toString("base64") === value;
  if (!isCanonicalBase64 || key.length !== 32) {
    throw invalidEncryptionConfig(`${variableName} must be a Base64-encoded 32-byte key.`);
  }
  return key;
}

function validateKeyId(value, variableName) {
  const id = clean(value);
  if (!KEY_ID_PATTERN.test(id)) {
    throw invalidEncryptionConfig(`${variableName} must be a non-secret key identifier.`);
  }
  return id;
}

function resolveEncryptionKeyring(env = process.env) {
  const legacyEncoded = clean(env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY);
  const activeEncoded = clean(env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE);
  const activeIdValue = clean(env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE_ID);
  const previousEncoded = clean(env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS);
  const previousIdValue = clean(env.REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS_ID);

  if (!activeEncoded && activeIdValue) {
    throw invalidEncryptionConfig("REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE is required when its key ID is configured.");
  }
  if (activeEncoded && !activeIdValue) {
    throw invalidEncryptionConfig("REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE_ID is required for the active key.");
  }
  if (Boolean(previousEncoded) !== Boolean(previousIdValue)) {
    throw invalidEncryptionConfig("The previous request-identification key and key ID must be configured together.");
  }

  const active = activeEncoded
    ? { id: validateKeyId(activeIdValue, "REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE_ID"),
      key: decodeEncryptionKey(activeEncoded, "REQUEST_IDENTIFICATION_ENCRYPTION_KEY_ACTIVE") }
    : { id: LEGACY_KEY_ID,
      key: decodeEncryptionKey(legacyEncoded, "REQUEST_IDENTIFICATION_ENCRYPTION_KEY") };
  const keys = new Map([[active.id, active.key]]);

  if (previousEncoded) {
    const previous = {
      id: validateKeyId(previousIdValue, "REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS_ID"),
      key: decodeEncryptionKey(previousEncoded, "REQUEST_IDENTIFICATION_ENCRYPTION_KEY_PREVIOUS"),
    };
    if (previous.id === active.id && !previous.key.equals(active.key)) {
      throw invalidEncryptionConfig("Active and previous key IDs cannot identify different keys.");
    }
    keys.set(previous.id, previous.key);
  }

  let legacyKey = legacyEncoded
    ? decodeEncryptionKey(legacyEncoded, "REQUEST_IDENTIFICATION_ENCRYPTION_KEY")
    : null;
  if (!legacyKey && keys.has(LEGACY_KEY_ID)) legacyKey = keys.get(LEGACY_KEY_ID);
  return Object.freeze({ active: Object.freeze(active), keys, legacyKey });
}

function getDecryptionKey(record, env = process.env) {
  const keyring = resolveEncryptionKeyring(env);
  if (record?.keyId) {
    if (!KEY_ID_PATTERN.test(record.keyId) || !keyring.keys.has(record.keyId)) {
      const error = new Error("The identification encryption key is unavailable.");
      error.code = "IDENTIFICATION_KEY_UNAVAILABLE";
      throw error;
    }
    return keyring.keys.get(record.keyId);
  }
  if (!keyring.legacyKey) {
    const error = new Error("The legacy identification encryption key is unavailable.");
    error.code = "IDENTIFICATION_KEY_UNAVAILABLE";
    throw error;
  }
  return keyring.legacyKey;
}

function validateIdentificationEncryptionConfig(env = process.env) {
  resolveEncryptionKeyring(env);
  return true;
}

function encryptIdNumber(idNumber, env = process.env, requestId = "") {
  const keyring = resolveEncryptionKeyring(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyring.active.key, iv);
  if (requestId) cipher.setAAD(Buffer.from(requestId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(idNumber, "utf8"), cipher.final()]);
  return {
    encryptionVersion: 1,
    algorithm: "aes-256-gcm",
    keyId: keyring.active.id,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptIdNumber(record, env = process.env) {
  if (record?.algorithm !== "aes-256-gcm" || record?.encryptionVersion !== 1) {
    throw new Error("Unsupported identification encryption format.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getDecryptionKey(record, env),
    Buffer.from(record.iv, "base64"),
  );
  if (record.requestId) decipher.setAAD(Buffer.from(record.requestId, "utf8"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function maskIdNumber(idNumber) {
  const value = String(idNumber || "");
  if (!value) return "";
  const visibleCount = value.length <= 4 ? 1 : Math.min(4, Math.floor(value.length / 2));
  return `${"•".repeat(value.length - visibleCount)}${value.slice(-visibleCount)}`;
}

function buildIdentificationRecord(requestId, participantId, validated, now = Timestamp.now()) {
  const encrypted = encryptIdNumber(validated.idNumber, process.env, requestId);
  return {
    requestId,
    participantId,
    identificationType: validated.identificationType,
    identificationTypeLabel: IDENTIFICATION_TYPES[validated.identificationType],
    maskedIdNumber: maskIdNumber(validated.idNumber),
    ...(validated.schoolInstitutionName
      ? { schoolInstitutionName: validated.schoolInstitutionName }
      : {}),
    ...encrypted,
    createdAt: now,
    updatedAt: now,
  };
}

function publicIdentification(record) {
  if (!record) return null;
  return {
    identificationType: record.identificationType,
    identificationTypeLabel: record.identificationTypeLabel || IDENTIFICATION_TYPES[record.identificationType] || "Identification Document",
    maskedIdNumber: record.maskedIdNumber || "",
    ...(record.schoolInstitutionName ? { schoolInstitutionName: record.schoolInstitutionName } : {}),
  };
}

async function getMaskedIdentifications(requestIds) {
  const entries = await Promise.all(requestIds.map(async (requestId) => {
    const doc = await db.collection(IDENTIFICATION_COLLECTION).doc(requestId).get();
    return [requestId, doc.exists ? publicIdentification(doc.data()) : null];
  }));
  return new Map(entries);
}

async function revealIdentification(requestId, adminUid) {
  const ref = db.collection(IDENTIFICATION_COLLECTION).doc(requestId);
  const doc = await ref.get();
  const writeAudit = (result) => db.collection(ACCESS_LOG_COLLECTION).add({
    adminUid, requestId, action: "VIEW_ID_INFORMATION", timestamp: Timestamp.now(), result,
  });
  if (!doc.exists) {
    await writeAudit("not_found");
    const error = new Error("Identification information not found.");
    error.code = "IDENTIFICATION_NOT_FOUND";
    throw error;
  }
  const record = doc.data();
  try {
    const idNumber = decryptIdNumber(record);
    await writeAudit("success");
    return { ...publicIdentification(record), idNumber };
  } catch (error) {
    await writeAudit("error");
    throw error;
  }
}

module.exports = {
  ACCESS_LOG_COLLECTION,
  IDENTIFICATION_COLLECTION,
  IDENTIFICATION_TYPES,
  buildIdentificationRecord,
  decryptIdNumber,
  encryptIdNumber,
  getMaskedIdentifications,
  maskIdNumber,
  publicIdentification,
  revealIdentification,
  validateIdentificationEncryptionConfig,
  validateIdentificationInput,
};
