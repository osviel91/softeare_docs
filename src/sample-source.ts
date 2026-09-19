/**
 * Default DSL source seeded into the editor (Phase 3).
 *
 * A small, valid diagram so the live preview is populated on first load. Kept in
 * its own module so both the app and tests can import a stable example.
 */
export const SAMPLE_SOURCE = `title Login

participant User
participant API
participant DB

User -> API: Login
API -> DB: Find user
DB --> API: User
API --> User: Token
`;
