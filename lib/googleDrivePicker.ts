/* eslint-disable @typescript-eslint/no-explicit-any */
// This module wraps the Google Picker/GSI browser globals, which ship no types.
declare global {
    interface Window {
        google: any;
        gapi: any;
    }
}

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

function loadScript(src: string) {
    return new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.body.appendChild(script);
    });
}

async function ensurePickerLoaded() {
    if (!window.google) {
        await loadScript("https://accounts.google.com/gsi/client");
    }
    if (!window.gapi) {
        await loadScript("https://apis.google.com/js/api.js");
    }

    await new Promise<void>((resolve) => {
        window.gapi.load("picker", { callback: resolve });
    });
}

async function requestAccessToken(scope = "https://www.googleapis.com/auth/drive.metadata.readonly") {
    if (!CLIENT_ID) {
        throw new Error("Missing NEXT_PUBLIC_GOOGLE_CLIENT_ID");
    }

    await ensurePickerLoaded();

    return new Promise<string>((resolve, reject) => {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope,
            callback: (resp: any) => {
                if (resp?.error) {
                    reject(resp);
                    return;
                }
                resolve(resp.access_token);
            },
        });

        tokenClient.requestAccessToken();
    });
}

export async function openGoogleDriveFolderPicker(
    onPicked: (folderId: string, folderName: string) => void
) {
    if (!API_KEY) {
        throw new Error("Missing NEXT_PUBLIC_GOOGLE_API_KEY");
    }

    const accessToken = await requestAccessToken();

    const picker = new window.google.picker.PickerBuilder()
        .setDeveloperKey(API_KEY)
        .setOAuthToken(accessToken)
        .addView(
            new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
                .setIncludeFolders(true)
                .setSelectFolderEnabled(true)
        )
        .setCallback((data: any) => {
            if (data.action === window.google.picker.Action.PICKED) {
                const doc = data.docs[0];
                onPicked(doc.id, doc.name);
            }
        })
        .build();

    picker.setVisible(true);
}

export type PickedDriveFile = { id: string; name: string; mimeType?: string };

/**
 * Multi-select Google Drive FILE picker. Returns the picked files AND the OAuth access token,
 * which the caller uses to download the files' bytes directly (the token carries the
 * `drive.readonly` scope so file content can be fetched).
 */
export async function openGoogleDriveFilePicker(
    onPicked: (files: PickedDriveFile[], accessToken: string) => void
) {
    if (!API_KEY) {
        throw new Error("Missing NEXT_PUBLIC_GOOGLE_API_KEY");
    }

    // drive.readonly (not just metadata) so we can download the picked files' content.
    const accessToken = await requestAccessToken("https://www.googleapis.com/auth/drive.readonly");

    const picker = new window.google.picker.PickerBuilder()
        .setDeveloperKey(API_KEY)
        .setOAuthToken(accessToken)
        .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
        .addView(
            new window.google.picker.DocsView()
                .setIncludeFolders(true)
                .setSelectFolderEnabled(false)
        )
        .setCallback((data: any) => {
            if (data.action === window.google.picker.Action.PICKED) {
                const files = (data.docs || []).map((d: any) => ({
                    id: d.id,
                    name: d.name,
                    mimeType: d.mimeType,
                }));
                onPicked(files, accessToken);
            }
        })
        .build();

    picker.setVisible(true);
}

// Google-native types must be EXPORTED to a downloadable format (mirrors the backend export map).
const DRIVE_NATIVE_EXPORT: Record<string, { mime: string; ext: string }> = {
    "application/vnd.google-apps.document": { mime: "application/pdf", ext: ".pdf" },
    "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: ".csv" },
    "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: ".pdf" },
    "application/vnd.google-apps.drawing": { mime: "application/pdf", ext: ".pdf" },
};

/** Download a picked Drive file's bytes in the browser and wrap them as a File for upload. */
export async function downloadDriveFile(file: PickedDriveFile, accessToken: string): Promise<File> {
    const native = file.mimeType ? DRIVE_NATIVE_EXPORT[file.mimeType] : undefined;
    const url = native
        ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(native.mime)}&supportsAllDrives=true`
        : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Couldn't download "${file.name}" from Drive (HTTP ${res.status})`);
    const blob = await res.blob();
    const name = native && !file.name.toLowerCase().endsWith(native.ext) ? file.name + native.ext : file.name;
    return new File([blob], name, { type: native?.mime || blob.type || "application/octet-stream" });
}

/** The on-disk filename a picked Drive file will have after download (for duplicate pre-check). */
export function driveFileName(file: PickedDriveFile): string {
    const native = file.mimeType ? DRIVE_NATIVE_EXPORT[file.mimeType] : undefined;
    return native && !file.name.toLowerCase().endsWith(native.ext) ? file.name + native.ext : file.name;
}
