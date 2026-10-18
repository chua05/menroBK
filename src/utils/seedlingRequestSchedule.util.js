const MANILA_TIME_ZONE = "Asia/Manila";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function manilaDateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(Number.isNaN(date.getTime()) ? new Date() : date);
}

function assertDateOnly(value, label) {
  const date = clean(value);
  if (!DATE_ONLY.test(date) || Number.isNaN(new Date(`${date}T00:00:00+08:00`).getTime())) {
    const error = new Error(`${label} must be a valid date.`);
    error.code = "INVALID_SCHEDULE";
    throw error;
  }
  return date;
}

function addWorkingDays(dateOnly, count) {
  const date = new Date(`${assertDateOnly(dateOnly, "Submission date")}T12:00:00+08:00`);
  let added = 0;
  while (added < count) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: MANILA_TIME_ZONE,
      weekday: "short",
    }).format(date);
    if (weekday !== "Sat" && weekday !== "Sun") added += 1;
  }
  return manilaDateOnly(date);
}

function buildProcessingEstimate(timestamp = new Date()) {
  const submittedDate = manilaDateOnly(timestamp);
  return {
    timezone: MANILA_TIME_ZONE,
    submittedDate,
    earliestDate: addWorkingDays(submittedDate, 3),
    latestDate: addWorkingDays(submittedDate, 7),
    workingDaysMinimum: 3,
    workingDaysMaximum: 7,
    holidayExclusionsApplied: false,
    advisory: true,
  };
}

function scheduleFromRequest(request = {}) {
  const proposal = request.eventProposal || {};
  return {
    preferredReleaseDate: clean(request.preferredReleaseDate),
    plantingDate: clean(proposal.proposedDate || request.proposedDate || request.eventDate),
    startTime: clean(proposal.proposedStartTime || proposal.startTime || request.startTime),
    endTime: clean(proposal.proposedEndTime || proposal.endTime || request.endTime),
  };
}

function normalizeSchedule(input = {}, fallback = {}) {
  return {
    preferredReleaseDate: clean(input.preferredReleaseDate ?? fallback.preferredReleaseDate),
    plantingDate: clean(input.plantingDate ?? input.proposedDate ?? fallback.plantingDate),
    startTime: clean(input.startTime ?? input.proposedStartTime ?? fallback.startTime),
    endTime: clean(input.endTime ?? input.proposedEndTime ?? fallback.endTime),
  };
}

function validateReleasePlantingOrder(schedule) {
  const release = assertDateOnly(schedule.preferredReleaseDate, "Preferred release date");
  const planting = assertDateOnly(schedule.plantingDate, "Planting date");
  if (planting < release) {
    const error = new Error("Planting date cannot be earlier than the release date.");
    error.code = "INVALID_SCHEDULE";
    throw error;
  }
  return { ...schedule, preferredReleaseDate: release, plantingDate: planting };
}

function validateFuturePlantingSchedule(schedule, now = new Date()) {
  const normalized = validateReleasePlantingOrder(schedule);
  if (normalized.preferredReleaseDate < manilaDateOnly(now)) {
    const error = new Error("The proposed release date is in the past. Coordinate a new release date before continuing.");
    error.code = "SCHEDULE_STALE";
    error.field = "preferredReleaseDate";
    throw error;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(normalized.startTime))) {
    const error = new Error("A valid planting start time is required."); error.code = "INVALID_SCHEDULE"; throw error;
  }
  if (normalized.endTime && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(normalized.endTime)) || normalized.endTime <= normalized.startTime)) {
    const error = new Error("Planting end time must be later than the start time."); error.code = "INVALID_SCHEDULE"; throw error;
  }
  const start = new Date(`${normalized.plantingDate}T${normalized.startTime}:00+08:00`);
  if (Number.isNaN(start.getTime()) || start.getTime() <= now.getTime()) {
    const error = new Error("The proposed planting date and time are in the past. Coordinate a new planting schedule before continuing.");
    error.code = "SCHEDULE_STALE";
    error.field = "plantingDate";
    throw error;
  }
  return normalized;
}

function samePlantingSchedule(left = {}, right = {}) {
  return clean(left.plantingDate) === clean(right.plantingDate) &&
    clean(left.startTime) === clean(right.startTime) &&
    clean(left.endTime) === clean(right.endTime);
}

function requestVersion(request = {}) {
  const version = Number(request.requestVersion ?? 0);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

function assertExpectedVersion(request, expectedVersion) {
  const expected = Number(expectedVersion);
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== requestVersion(request)) {
    const error = new Error("This request was updated by another action. Refresh and try again.");
    error.code = "STALE_REQUEST_VERSION";
    throw error;
  }
}

module.exports = {
  MANILA_TIME_ZONE,
  manilaDateOnly,
  addWorkingDays,
  buildProcessingEstimate,
  scheduleFromRequest,
  normalizeSchedule,
  validateReleasePlantingOrder,
  validateFuturePlantingSchedule,
  samePlantingSchedule,
  requestVersion,
  assertExpectedVersion,
};
