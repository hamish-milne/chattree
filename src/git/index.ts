export {
  Git,
  type CommitInfo,
  type CommitOptions,
  type DiffEntry,
  type GitOptions,
  type Identity,
  type MergeMessage,
  type MergeTreeResult,
  type RefInfo,
  type RunOptions,
  type StatusEntry,
  type TreeEdit,
  type WorktreeInfo,
} from "./git.ts";
export { MIN_GIT_VERSION, compareVersions, formatVersion, parseGitVersion, type GitVersion } from "./version.ts";
