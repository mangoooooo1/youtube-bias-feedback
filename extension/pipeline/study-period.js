// 대조군(CON, TEST-CON) 판별
const CONTROL_GROUP_CODES = new Set(["CON", "TEST-CON"]);
export function isConGroup(code) {
  return CONTROL_GROUP_CODES.has(code);
}
