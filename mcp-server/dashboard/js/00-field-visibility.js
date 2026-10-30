'use strict';
// ─── PLAYGROUND FIELD VISIBILITY ─────────────────────────────────
// A tool with several actions needs different inputs per action. A field that sets `showFor: ['a', 'b']` is
// shown only while the tool's action field (`tool.actionField`, default 'action') holds one of those values;
// a field without `showFor` is always shown. With no action chosen yet every field is shown, so nothing is hidden
// from someone who has not picked one.
function fieldVisibleFor(field, action) {
  if (!field || !Array.isArray(field.showFor) || field.showFor.length === 0) return true;
  if (!action) return true;
  return field.showFor.includes(action);
}
