// bookish-schema.js — Bookish schema declaration for the Tarn SDK.
//
// This is the canonical, single source of truth for what a Bookish book
// record looks like on the wire. The Tarn SDK uses this declaration to:
//
//   - Validate every create/update synchronously (before any network or
//     crypto work) and throw TarnSchemaError on missing required fields,
//     unknown fields, type mismatches, or enum violations.
//   - Generate the typed namespace `tarn.books.*` (vanilla JS callers get
//     the runtime validation; only the autocomplete is TS-only).
//   - Publish to Arweave under Type='app-schema' / App='bookish' so a
//     future on-Arweave recovery client can decode entries without going
//     through the Tarn API.
//
// Field set mirrors public/schemas/bookish_0.3.0.json (the previous Ajv-
// based schema). Schema version is bumped from 0.3.0 → 4 (the new SDK
// uses positive integers, not semver strings).
//
// IMPORTANT: every field a Bookish entry might carry must be declared
// here. The SDK rejects unknown fields. Keep this file in lockstep with
// the BookRepository payload builder.

import { defineSchema } from '../lib/tarn/tarn-client.bundle.js';

export const bookishSchema = defineSchema({
  appId: 'bookish',
  version: 4,
  collections: {
    books: {
      primaryKey: 'bookId',
      fields: {
        bookId: 'string',
        title: 'string',
        author: 'string?',
        // 'print' / 'audio' are the generic values the add-book form
        // emits today (see public/index.html option values + mapFormat()
        // in app.js). 'paperback' / 'hardcover' / 'audiobook' are reserved
        // for a future fidelity bump if users ever ask for the distinction.
        // 'ebook' and 'other' work for both surfaces. Keep all six valid
        // until the form is canonicalized.
        format: { type: 'string', enum: ['print', 'paperback', 'hardcover', 'ebook', 'audiobook', 'audio', 'other'] },

        // Read-shelf metadata. dateRead is a ms-epoch number at noon UTC
        // (legacy YYYY-MM-DD strings were normalized away pre-migration).
        dateRead: 'number?',
        readingStatus: { type: 'string', enum: ['want_to_read', 'reading', 'read'], required: false },
        readingStartedAt: 'number?',

        // Want-to-read sort position (0 = top of WTR list).
        wtrPosition: 'integer?',

        // Cover art (base64-encoded). mimeType paired so the renderer
        // knows how to interpret coverImage. coverFit captures the user's
        // crop / fit preference for the cover (cover | contain).
        coverImage: 'string?',
        mimeType: 'string?',
        coverFit: 'string?',

        // Friend-matching identifiers (issue #111). work_key is the
        // OpenLibrary work key used for strict equality matching across
        // friends' libraries; isbn13 is the optional fallback.
        work_key: 'string?',
        isbn13: 'string?',

        // Per-book privacy flag (issue #129 / FRIENDS.md Surface 7).
        // True = excluded from share-log publication. Absent or false =
        // public (the publish-on-save path treats them identically).
        is_private: 'boolean?',

        // Free-form fields the user fills in.
        notes: 'string?',
        rating: 'integer?',
        // tags are user-entered, sometimes as a string (comma-separated)
        // and sometimes as a parsed array. `json?` accepts both shapes.
        tags: 'json?',
        // Whether the user owns this copy (paperback / hardcover toggle).
        owned: 'boolean?',

        // Audit timestamps.
        createdAt: 'number?',
        modifiedAt: 'number?',
      },
      shareable: true,
    },
  },
});

export default bookishSchema;
