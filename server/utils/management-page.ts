import { useStorage } from "nitropack/runtime"
import { ApiError } from "../v2/shared/errors"

async function getManagementAsset(name: string): Promise<string> {
  const asset = await useStorage("/assets").getItem<string>(`ui/${name}`)
  if (!asset) {
    throw new ApiError("The management page is unavailable", { status: 500, code: "management_page_unavailable" })
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
