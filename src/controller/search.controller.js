const { globalSearch } = require("../services/search.service");

async function search(req, res) {
  try {
    const query = String(req.query.q || "").trim();
    if (query.length < 2) {
      return res.status(400).json({ success: false, message: "Search requires at least 2 characters." });
    }
    if (query.length > 100) {
      return res.status(400).json({ success: false, message: "Search must be 100 characters or fewer." });
    }
    const results = await globalSearch({
      query,
      role: req.user.role,
      userId: req.user.uid,
      limit: req.query.limit,
    });
    return res.status(200).json({ success: true, data: { results } });
  } catch (error) {
    console.error("Global search error:", error);
    return res.status(500).json({ success: false, message: "Unable to search system records." });
  }
}

module.exports = { search };
