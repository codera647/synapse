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

async function requestAccessToken() {
    if (!CLIENT_ID) {
        throw new Error("Missing NEXT_PUBLIC_GOOGLE_CLIENT_ID");
    }

    await ensurePickerLoaded();

    return new Promise<string>((resolve, reject) => {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: "https://www.googleapis.com/auth/drive.metadata.readonly",
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

/** Multi-select Google Drive FILE picker (used to add files to an existing library). */
export async function openGoogleDriveFilePicker(
    onPicked: (files: PickedDriveFile[]) => void
) {
    if (!API_KEY) {
        throw new Error("Missing NEXT_PUBLIC_GOOGLE_API_KEY");
    }

    const accessToken = await requestAccessToken();

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
                onPicked(files);
            }
        })
        .build();

    picker.setVisible(true);
}
