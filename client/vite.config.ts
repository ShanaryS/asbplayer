import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createHtmlPlugin } from 'vite-plugin-html';
import { VitePWA } from 'vite-plugin-pwa';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import artifactLock from '@project/ffmpeg/artifact-lock.json';
import ffmpegPackage from '@project/ffmpeg/package.json';
import ffmpegBuildConfig from '@project/ffmpeg/build-config.json';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd());
    const domain = env.VITE_APP_DOMAIN || 'app.asbplayer.dev';
    const base = env.VITE_APP_BASE_PATH || '/';
    const candidate = ['1', 'true'].includes(env.VITE_FFMPEG_CANDIDATE?.toLowerCase());
    const runtimeVersion = candidate ? ffmpegPackage.version : artifactLock.runtimeVersion;
    const ffmpegVersion = candidate ? ffmpegBuildConfig.ffmpeg.version : artifactLock.ffmpegVersion;
    const sourceUrl = candidate ? ffmpegBuildConfig.ffmpeg.source.url : artifactLock.releaseUrl;
    const preparationScript = candidate ? 'verify-artifacts.mjs' : 'fetch.mjs';
    execFileSync(
        process.execPath,
        [
            path.resolve(__dirname, '../ffmpeg/scripts', preparationScript),
            ...(candidate ? ['--candidate', '--source'] : []),
        ],
        { stdio: 'inherit' }
    );
    const manifest = JSON.parse(
        readFileSync(path.resolve(__dirname, `../ffmpeg/dist/${runtimeVersion}/manifest.json`), 'utf8')
    ) as {
        runtime: Array<{ filename: string; sha256: string; bytes: number }>;
    };
    const runtimeFiles: Record<string, string> = candidate
        ? Object.fromEntries(manifest.runtime.map((entry) => [entry.filename, entry.sha256]))
        : artifactLock.runtimeFiles;
    const runtimeHashes = Object.fromEntries(
        ['ffmpeg-worker.js', 'ffmpeg-core.js', 'ffmpeg-core.wasm'].map((filename) => [filename, runtimeFiles[filename]])
    );
    const runtimeSizes = Object.fromEntries(manifest.runtime.map((entry) => [entry.filename, entry.bytes]));
    return {
        base,
        define: {
            __ASB_FFMPEG_RUNTIME_VERSION__: JSON.stringify(runtimeVersion),
            __ASB_FFMPEG_VERSION__: JSON.stringify(ffmpegVersion),
            __ASB_FFMPEG_SOURCE_URL__: JSON.stringify(sourceUrl),
            __ASB_FFMPEG_RUNTIME_HASHES__: JSON.stringify(runtimeHashes),
            __ASB_FFMPEG_RUNTIME_SIZES__: JSON.stringify(runtimeSizes),
        },
        resolve: {
            tsconfigPaths: true,
        },
        build: {
            sourcemap: true,
        },
        plugins: [
            react(),
            createHtmlPlugin({
                inject: {
                    data: {
                        plausible:
                            mode === 'production'
                                ? `<script defer data-domain="${domain}" src="https://plausible.io/js/script.js"></script>`
                                : '',
                        url: `https://${domain}${base}`,
                    },
                },
            }),
            viteStaticCopy({
                targets: [
                    {
                        src: '../common/locales',
                        dest: '',
                    },
                    {
                        src: '../common/assets',
                        dest: '',
                    },
                    {
                        src: `../ffmpeg/dist/${runtimeVersion}`,
                        dest: 'ffmpeg',
                    },
                ],
            }),
            VitePWA({
                strategies: 'injectManifest',
                srcDir: 'src',
                filename: 'sw.ts',
                registerType: 'prompt',
                includeAssets: ['locales/*.json', 'background-colored.png'],
                manifest: {
                    short_name: 'asbplayer',
                    name: 'a subtitle player',
                    description: 'A browser-based media player for mining sentences from subtitles',
                    icons: [
                        {
                            src: 'favicon.ico',
                            sizes: '48x48 32x32 16x16',
                            type: 'image/x-icon',
                        },
                        {
                            src: 'logo192.png',
                            type: 'image/png',
                            sizes: '192x192',
                        },
                        {
                            src: 'logo512.png',
                            type: 'image/png',
                            sizes: '512x512',
                        },
                    ],
                    start_url: '.',
                    display: 'standalone',
                    theme_color: '#000000',
                    background_color: '#ffffff',
                    orientation: 'any',
                },
                devOptions: {
                    enabled: false,
                },
                injectManifest: {
                    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,txt}'],
                    globIgnores: ['**/ffmpeg/**'],
                    sourcemap: true,
                },
            }),
        ],
        server: {
            open: true,
            port: 3000,
        },
    };
});
