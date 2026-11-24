// Provisional list; MENRO has not confirmed it. Configurable.
const MORTALITY_CAUSES = Object.freeze(["Unknown", "Drought", "Pest/Disease", "Flooding", "Physical Damage"]);
const MORTALITY_CAUSES_STATUS = "PROVISIONAL_PENDING_MENRO_CONFIRMATION";

// The proposed 100 m monitoring GPS limit is NOT active. The existing stricter site/accuracy rules
// (coverage radius -> polygon -> 50 m fallback, accuracy <= 50 m) apply until MENRO authorises it.
const PROPOSED_MONITORING_GPS_LIMIT_METERS = 100;
const MONITORING_GPS_LIMIT_ACTIVE = false;

module.exports = {
  MORTALITY_CAUSES, MORTALITY_CAUSES_STATUS,
  PROPOSED_MONITORING_GPS_LIMIT_METERS, MONITORING_GPS_LIMIT_ACTIVE,
};
