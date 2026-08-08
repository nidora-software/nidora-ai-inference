/**
 * Artifact filename validation.
 *
 * One validator, used by every route that accepts a filename from a pod. It
 * lives here rather than inline because having the rule in two places is
 * exactly how the traversal bug happened: the upload route validated, the
 * result route did not, and the result route's value is the one handed to
 * clients.
 *
 * A pod is a realistic adversary — it runs on rented third-party hardware, and
 * the agent secret is documented as compromise-prone. So a filename from a pod
 * is untrusted input on two paths at once: it becomes a path segment on the
 * gateway's disk, and it becomes a URL the product backend fetches with its own
 * credentials.
 */

/** No separators, no traversal, no shell/URL metacharacters. */
const SAFE = /^[A-Za-z0-9._-]+$/;

/**
 * `.` and `..` pass the character class but are not names:
 *   - on disk, `rename()` onto `.` targets the job directory itself
 *   - in a URL, `..` is a traversal segment that `new URL()` collapses,
 *     which is what let a pod steer a client's authenticated fetch
 * Any all-dots name is rejected for the same reason.
 */
const DOTS_ONLY = /^\.+$/;

export function isSafeFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    SAFE.test(value) &&
    !DOTS_ONLY.test(value)
  );
}
