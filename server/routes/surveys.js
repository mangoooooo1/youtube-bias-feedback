const express = require("express");
const { success } = require("../middleware/responseHandler");

const router = express.Router();

router.post("/", (req, res) => {
  return success(res);
});

module.exports = router;
