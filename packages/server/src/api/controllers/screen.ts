import { DocumentType } from "../../db/utils"
import {
  context,
  db as dbCore,
  events,
  roles,
  tenancy,
} from "@budibase/backend-core"
import { updateAppPackage } from "./application"
import {
  DeleteScreenResponse,
  FetchScreenResponse,
  Plugin,
  SaveScreenRequest,
  SaveScreenResponse,
  Screen,
  ScreenProps,
  ScreenUsage,
  UsageInScreensResponse,
  UserCtx,
} from "@budibase/types"
import { builderSocket } from "../../websockets"
import sdk from "../../sdk"
import { sdk as sharedSdk } from "@budibase/shared-core"

export async function fetch(ctx: UserCtx<void, FetchScreenResponse>) {
  const screens = await sdk.screens.fetch()

  const roleId = ctx.user?.role?._id as string
  if (!roleId) {
    ctx.throw("Unable to retrieve users role ID.")
  }
  ctx.body = await new roles.AccessController().checkScreensAccess(
    screens,
    roleId
  )
}

export async function save(
  ctx: UserCtx<SaveScreenRequest, SaveScreenResponse>
) {
  const db = context.getAppDB()
  const screen = ctx.request.body

  const isCreation = !screen._id

  const savedScreen = isCreation
    ? await sdk.screens.create(screen)
    : await sdk.screens.update(screen)

  // Find any custom components being used
  let pluginNames: string[] = []
  let pluginAdded = false
  findPlugins(screen.props, pluginNames)
  if (pluginNames.length) {
    const globalDB = tenancy.getGlobalDB()
    const pluginsResponse = await globalDB.allDocs(
      dbCore.getPluginParams(null, {
        include_docs: true,
      })
    )
    const requiredPlugins = pluginsResponse.rows
      .map((row: any) => row.doc)
      .filter((plugin: Plugin) => {
        return (
          plugin.schema.type === "component" &&
          pluginNames.includes(`plugin/${plugin.name}`)
        )
      })

    // Update the app metadata
    const application = await db.get<any>(DocumentType.APP_METADATA)
    let usedPlugins = application.usedPlugins || []

    requiredPlugins.forEach((plugin: Plugin) => {
      if (!usedPlugins.find((x: Plugin) => x._id === plugin._id)) {
        pluginAdded = true
        usedPlugins.push({
          _id: plugin._id,
          name: plugin.name,
          version: plugin.version,
          jsUrl: plugin.jsUrl,
          hash: plugin.hash,
        })
      }
    })

    if (pluginAdded) {
      await updateAppPackage({ usedPlugins }, ctx.appId)
    }
  }

  if (isCreation) {
    await events.screen.created(screen)
  }
  ctx.message = `Screen ${screen.name} saved.`
  ctx.body = {
    ...savedScreen,
    pluginAdded,
  }
  builderSocket?.emitScreenUpdate(ctx, savedScreen)
}

export async function destroy(ctx: UserCtx<void, DeleteScreenResponse>) {
  const db = context.getAppDB()
  const id = ctx.params.screenId
  const screen = await db.get<Screen>(id)

  await db.remove(id, ctx.params.screenRev)

  await events.screen.deleted(screen)
  ctx.body = {
    message: "Screen deleted successfully",
  }
  builderSocket?.emitScreenDeletion(ctx, id)
}

function findPlugins(component: ScreenProps, foundPlugins: string[]) {
  if (!component) {
    return
  }
  if (component._component.startsWith("plugin")) {
    if (!foundPlugins.includes(component._component)) {
      foundPlugins.push(component._component)
    }
  }
  if (!component._children || !component._children.length) {
    return
  }
  component._children.forEach(child => findPlugins(child, foundPlugins))
}

export async function usage(ctx: UserCtx<void, UsageInScreensResponse>) {
  const sourceId = ctx.params.sourceId
  const sourceType = sdk.common.getSourceType(sourceId)
  const allScreens = await sdk.screens.fetch()
  const response: ScreenUsage[] = []
  for (let screen of allScreens) {
    const found = sharedSdk.screens.findInSettings(screen, sourceId)
    if (found.length !== 0) {
      response.push({
        url: screen.routing.route,
        _id: screen._id!,
      })
    }
  }
  ctx.body = {
    sourceType,
    screens: response,
  }
}
