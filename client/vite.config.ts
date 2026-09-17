import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createHtmlPlugin } from 'vite-plugin-html';
import { VitePWA } from 'vite-plugin-pwa';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { execFileSync } from 'node:child_process';
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
    return {
        base,
        define: {
            __ASB_FFMPEG_RUNTIME_VERSION__: JSON.stringify(runtimeVersion),
            __ASB_FFMPEG_VERSION__: JSON.stringify(ffmpegVersion),
            __ASB_FFMPEG_SOURCE_URL__: JSON.stringify(sourceUrl),
        },
        resolve: {
            tsconfigPaths: true,
        },
        plugins: [
            {
                name: 'verify-ffmpeg-runtime',
                buildStart() {
                    execFileSync(
                        process.execPath,
                        [
                            path.resolve(__dirname, '../ffmpeg/scripts/verify-artifacts.mjs'),
                            ...(candidate ? ['--candidate', '--source'] : []),
                        ],
                        {
                            stdio: 'inherit',
                        }
                    );
                },
            },
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
                workbox: {
                    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,txt}'],
                    globIgnores: ['**/ffmpeg/**'],
                    navigateFallbackDenylist: [/\/ffmpeg\//],
                    runtimeCaching: [
                        {
                            urlPattern: ({ url }) =>
                                /\/ffmpeg\/[^/]+\/(ffmpeg-(worker|core)\.(js|wasm)|manifest\.json)$/.test(url.pathname),
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'asbplayer-ffmpeg-runtime',
                                expiration: {
                                    maxEntries: 3,
                                },
                            },
                        },
                    ],
                },
            }),
        ],
        server: {
            open: true,
            port: 3000,
        },
    };
});
