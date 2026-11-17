/**
 * Re-export of the harness's one-shot model call, so CLI code imports it from one place. The call is a single model
 * request outside the transcript, with no tools; nothing is stored unless the caller records the result.
 */
export { askModel, type OneShot } from "../harness/oneshot.ts";
