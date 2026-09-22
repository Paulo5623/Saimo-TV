import { useEffect, useState } from 'react';

export interface PublicUiConfig {
  appPromotionEnabled: boolean;
  appDownloadUrl: string;
}

const defaults: PublicUiConfig = {
  appPromotionEnabled: false,
  appDownloadUrl: '#/app',
};

export function usePublicUiConfig(): PublicUiConfig {
  const [config, setConfig] = useState(defaults);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/public/config', { signal: controller.signal, credentials: 'same-origin' })
      .then((response) => response.ok ? response.json() : null)
      .then((value: Record<string, unknown> | null) => {
        if (!value) return;
        const customUrl = String(value.app_download_url || '').trim();
        setConfig({
          appPromotionEnabled: String(value.app_promotion_enabled || 'false') === 'true',
          appDownloadUrl: customUrl || defaults.appDownloadUrl,
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      });

    return () => controller.abort();
  }, []);

  return config;
}
