import type {
    FileSessionRecord,
    FileSystemFileHandleWithId,
} from '@project/common/file-system-access/file-system-access-repository';
import {
    subtitleSourceMatches,
    plainSrtMimeType,
    pgsMimeType,
} from '@project/common/embedded-subtitles/embedded-subtitles';
import type { EmbeddedSubtitleDescriptor } from '@project/common/embedded-subtitles/embedded-subtitles';
/**
 * File System Access API helpers (Chrome-only).
 * Provides showOpenFilePicker-based file selection that returns FileSystemFileHandle objects,
 * and utilities to re-acquire permissions and resolve handles back to File objects on revisit.
 */

import type { FileWithId } from '@project/common/file-selector';
import { v4 as uuidv4 } from 'uuid';

export function supportsFileSystemAccess(): boolean {
    return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

export async function requestPermissions(
    handles: FileSystemFileHandleWithId[]
): Promise<{ granted: FileSystemFileHandleWithId[]; denied: FileSystemFileHandleWithId[] }> {
    const granted: FileSystemFileHandleWithId[] = [];
    const denied: FileSystemFileHandleWithId[] = [];

    for (const handle of handles) {
        try {
            const state = await (handle.handle as any).queryPermission?.({ mode: 'read' });
            if (state === 'granted') {
                granted.push(handle);
                continue;
            }
        } catch {
            // queryPermission not supported, fall through to requestPermission
        }

        try {
            const state = await (handle.handle as any).requestPermission?.({ mode: 'read' });
            if (state === 'granted') {
                granted.push(handle);
            } else {
                denied.push(handle);
            }
        } catch {
            denied.push(handle);
        }
    }

    return { granted, denied };
}

export async function resolveFiles(
    handles: FileSystemFileHandleWithId[]
): Promise<{ files: FileWithId[]; errors: FileSystemFileHandleWithId[] }> {
    const files: FileWithId[] = [];
    const errors: FileSystemFileHandleWithId[] = [];

    for (const handle of handles) {
        try {
            files.push({ id: handle.id, file: await handle.handle.getFile() });
        } catch {
            errors.push(handle);
        }
    }

    return { files, errors };
}

/** A session needs saved file contents or handles to offer restoration. */
export function canRestoreSession(record: FileSessionRecord | undefined): boolean {
    return (
        record !== undefined &&
        (record.videoHandle !== undefined ||
            record.subtitleHandles.length > 0 ||
            (record.cachedSubtitleFiles?.length ?? 0) > 0)
    );
}

export async function showFilePicker(extensions: {
    videoExtensions: string[];
    audioExtensions: string[];
    subtitleExtensions: string[];
}): Promise<FileSystemFileHandleWithId[] | undefined> {
    if (!supportsFileSystemAccess()) {
        return undefined;
    }

    try {
        const handles = await (window as any).showOpenFilePicker({
            multiple: true,
            types: [
                {
                    description: 'Media and subtitle files',
                    accept: {
                        'video/*': extensions.videoExtensions,
                        'audio/*': extensions.audioExtensions,
                        'text/*': extensions.subtitleExtensions,
                    },
                },
            ],
        });
        return (handles as FileSystemFileHandle[]).map((handle) => ({ handle, id: uuidv4() }));
    } catch (e: any) {
        if (e.name === 'AbortError') {
            return undefined;
        }
        throw e;
    }
}

/** Reconstruct slots only after all available embedded sources have been resolved. */
export async function restoreSessionFiles(
    record: FileSessionRecord,
    resolvedFiles: FileWithId[],
    extract?: (source: FileWithId, descriptors: EmbeddedSubtitleDescriptor[]) => Promise<Map<string, FileWithId>>
) {
    const video = resolvedFiles.find((file) => file.id === record.videoHandle?.id);
    const files = new Map(resolvedFiles.map((file) => [file.id, file]));
    // Files read from disk may have changed since the session was cached.
    for (const file of record.cachedSubtitleFiles ?? []) if (!files.has(file.id)) files.set(file.id, file);
    const missing: EmbeddedSubtitleDescriptor[] = [];
    for (const [id, descriptor] of Object.entries(record.embeddedSubtitles ?? {})) {
        if (!video || !subtitleSourceMatches(video, descriptor)) {
            files.delete(id);
            continue;
        }
        const cached = files.get(id);
        if (
            (descriptor.format === 'srt' && cached?.file.type === plainSrtMimeType) ||
            (descriptor.format === 'sup' &&
                cached?.file.type === pgsMimeType &&
                Number.isFinite(descriptor.timelineOffsetMs))
        )
            files.set(id, { ...cached, embedded: descriptor });
        else {
            files.delete(id);
            missing.push(descriptor);
        }
    }
    if (video && missing.length > 0 && extract) {
        try {
            for (const [id, file] of await extract(video, missing)) files.set(id, file);
        } catch {
            /* Preserve unavailable slot positions and descriptors for a later retry. */
        }
    }
    if (!record.subtitleTrackIds) return [...files.values()];
    return [
        ...(video ? [video] : []),
        ...record.subtitleTrackIds.map(
            (id) =>
                (id === '-' ? undefined : files.get(id)) ?? {
                    id: record.embeddedSubtitles?.[id] ? id : '-',
                    embedded: record.embeddedSubtitles?.[id],
                    file: new File([''], '.srt'),
                }
        ),
    ];
}
