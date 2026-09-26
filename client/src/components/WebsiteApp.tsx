import type { Fetcher } from '@project/common';
import { useChromeExtension } from '@project/common/app';
import RootApp from '@project/common/app/components/RootApp';
import { useEffect, useMemo } from 'react';
import { AppExtensionDictionaryStorage } from '@project/common/app/services/app-extension-dictionary-storage';
import { AppExtensionSettingsStorage } from '@project/common/app/services/app-extension-settings-storage';
import { AppExtensionGlobalStateProvider } from '@project/common/app/services/app-extension-global-state-provider';
import { SettingsProvider } from '@project/common/settings';
import { asbError, configureLogProvider, LogProvider } from '@project/common/util';
import { IndexedDBLogStore } from '@project/common/util/indexed-db-log-store';
import { LocalDictionaryStorage } from '@project/client/src/local-dictionary-storage';
import { LocalSettingsStorage } from '@project/client/src/local-settings-storage';
import { AppExtensionLogStorage } from '@project/common/app/services/app-extension-log-storage';

interface Props {
    origin: string;
    logoUrl: string;
    fetcher: Fetcher;
}

const WebsiteApp = (props: Props) => {
    const extension = useChromeExtension({ component: 'application' });
    const settingsStorage = useMemo(() => {
        if (extension.supportsAppIntegration) return new AppExtensionSettingsStorage(extension);
        return new LocalSettingsStorage();
    }, [extension]);
    useEffect(() => {
        if (extension.version) window.plausible?.('extension_version', { props: { version: extension.version } });
    }, [extension.version]);
    const settingsProvider = useMemo(() => new SettingsProvider(settingsStorage), [settingsStorage]);
    const localLogStore = useMemo(() => new IndexedDBLogStore(), []);
    const logProvider = useMemo(
        () => new LogProvider(extension.supportsLogs ? new AppExtensionLogStorage(extension) : localLogStore),
        [extension, localLogStore]
    );
    useEffect(() => {
        const configured = configureLogProvider(logProvider);
        if (!extension.supportsLogs) return;
        void configured
            .then(() => localLogStore.delete()) // Discard logs written locally before the extension was detected
            .catch((error) => asbError('app/log-storage', 'Failed to delete local log database', error));
    }, [extension.supportsLogs, localLogStore, logProvider]);
    const dictionaryStorage = useMemo(() => {
        if (extension.supportsDictionary) return new AppExtensionDictionaryStorage(extension);
        return new LocalDictionaryStorage(settingsProvider);
    }, [extension, settingsProvider]);
    const globalStateProvider = useMemo(() => new AppExtensionGlobalStateProvider(extension), [extension]);
    return (
        <RootApp
            {...props}
            extension={extension}
            dictionaryStorage={dictionaryStorage}
            settingsStorage={settingsStorage}
            settingsProvider={settingsProvider}
            globalStateProvider={globalStateProvider}
            logProvider={logProvider}
        />
    );
};

export default WebsiteApp;
