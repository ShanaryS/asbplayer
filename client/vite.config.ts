import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createHtmlPlugin } from 'vite-plugin-html';
import { VitePWA } from 'vite-plugin-pwa';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd());
    const domain = env.VITE_APP_DOMAIN || 'app.asbplayer.dev';
    const base = env.VITE_APP_BASE_PATH || '/';
    return {
        base,
        resolve: {
            tsconfigPaths: true,
        },
        plugins: [
            {
                name: 'verify-ffmpeg-runtime',
                buildStart() {
                    execFileSync(
                        process.execPath,
                        [path.resolve(__dirname, '../ffmpeg/scripts/verify-artifacts.mjs'), '--source'],
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
                        src: '../ffmpeg/dist/0.1.0',
                        dest: 'ffmpeg',
                    },
                    {
                        src: '../ffmpeg/dist/0.1.0/notices/*',
                        dest: 'ffmpeg-notices',
                    },
                    {
                        src: '../ffmpeg/release/asbplayer-ffmpeg-0.1.0-source.tar.xz',
                        dest: 'ffmpeg/0.1.0',
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
                    globIgnores: ['**/ffmpeg/**'],
                    navigateFallbackDenylist: [/\/ffmpeg\//],
                    runtimeCaching: [
                        {
                            urlPattern: ({ url }) => url.pathname.includes('/ffmpeg/'),
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'asbplayer-ffmpeg-runtime',
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
