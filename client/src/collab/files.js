// Validation rules for workspace files. These are the first line of defense;
// the server's payload cap and per-room update budget are the backstop.
//
// Security model reminder: files here are TEXT inside a shared Yjs document.
// Nothing on the server ever executes, imports, or writes them to disk, so a
// "malicious" file is inert data. These limits exist to prevent the two real
// risks: resource exhaustion (huge/binary blobs) and weird names that could
// confuse the UI.

export const MAX_FILES = 50;
export const MAX_FILE_CHARS = 200_000; // ~200 KB of text per file
export const MAX_UPLOAD_BYTES = 200_000;

// Text formats only. No executables, no images, no archives.
export const ALLOWED_EXTENSIONS = [
  'js', 'jsx', 'ts', 'tsx', 'json',
  'md', 'txt', 'css', 'html',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'sh', 'sql', 'yml', 'yaml', 'toml', 'env.example'
];

/**
 * Returns an error string, or null if the name is acceptable.
 * The pattern forbids slashes (so names can never look like paths),
 * whitespace, and HTML-significant characters; leading dots are blocked
 * so nothing masquerades as a hidden/config file.
 */
export function validateFileName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    return 'File names can use letters, numbers, dots, dashes and underscores (max 64 chars) and must start with a letter or number.';
  }
  if (!name.includes('.')) {
    return 'Please include a file extension, e.g. notes.md';
  }
  const ext = name.split('.').pop().toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `".${ext}" isn't supported. Text formats only: ${ALLOWED_EXTENSIONS.join(', ')}`;
  }
  return null;
}

/** Cheap binary sniff: real text files never contain NUL bytes. */
export function looksBinary(text) {
  return text.includes('\u0000');
}
