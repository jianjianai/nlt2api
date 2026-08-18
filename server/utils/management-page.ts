import { useStorage } from "nitropack/runtime"
import { AppError } from "./errors"

async function getManagementAsset(name: string): Promise<string> {
  const asset = await useStorage("/assets").getItem<string>(`ui/${name}`)
  if (!asset) {
    throw new AppError("The management page is unavailable", 500, "management_page_unavailable")
  }
  return asset
}

export function getManagementPage(): Promise<string> {
  return getManagementAsset("index.html")
}

export function getManagementScript(): Promise<string> {
  return getManagementAsset("app.js")
}

export function getManagementStyles(): Promise<string> {
  return getManagementAsset("styles.css")
}

export function getDebugPage(): Promise<string> {
  return getManagementAsset("debug.html")
}

export function getDebugScript(): Promise<string> {
  return getManagementAsset("debug.js")
}

export function getDebugStyles(): Promise<string> {
  return getManagementAsset("debug.css")
}
