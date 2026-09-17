export function archiveHasPath(paths: string[], archiveRoot: string, relativePath: string): boolean;
export function validateSingleArchiveRoot(paths: string[], archiveDescription: string): string;
export function verifyArchiveEntryTypes(listing: string, archiveDescription: string): void;
export function verifyRuntimeArchive(archivePath: string, expectedRoot: string): Promise<string[]>;
