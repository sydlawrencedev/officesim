import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/*
 * The asset index the office UI loads (officesim-assets.json): characters, floors, walls, every
 * furniture piece from its manifest, and the layouts. Shared by the plugin build and the Mac app.
 */

function flattenFurnitureManifest(manifest, dirName, inherited = {}) {
  const fileName = manifest.file ?? `${manifest.id}.png`;
  // Nested groups (e.g. a state group inside a rotation group) often have no id of their own:
  // they belong to their parent's group, and an unnamed animation group is named after its place.
  const groupId = manifest.type === "group" && manifest.id ? manifest.id : inherited.groupId;
  const orientation = manifest.orientation ?? inherited.orientation;
  const state = manifest.state ?? inherited.state;
  const base = {
    category: manifest.category ?? inherited.category ?? "misc",
    groupId,
    orientation,
    state,
    rotationScheme: manifest.rotationScheme ?? inherited.rotationScheme,
    animationGroup: manifest.groupType === "animation"
      ? manifest.id ?? [groupId, orientation, state].filter(Boolean).join("_")
      : inherited.animationGroup,
    canPlaceOnSurfaces: manifest.canPlaceOnSurfaces ?? inherited.canPlaceOnSurfaces,
    backgroundTiles: manifest.backgroundTiles ?? inherited.backgroundTiles,
    canPlaceOnWalls: manifest.canPlaceOnWalls ?? inherited.canPlaceOnWalls,
    mirrorSide: manifest.mirrorSide ?? inherited.mirrorSide,
  };

  if (manifest.type === "asset") {
    return [{
      id: manifest.id,
      label: manifest.name ?? inherited.name ?? manifest.id,
      category: base.category,
      width: manifest.width,
      height: manifest.height,
      footprintW: manifest.footprintW,
      footprintH: manifest.footprintH,
      isDesk: base.category === "desks",
      groupId: base.groupId,
      orientation: base.orientation,
      state: base.state,
      rotationScheme: base.rotationScheme,
      animationGroup: base.animationGroup,
      frame: manifest.frame,
      canPlaceOnSurfaces: !!base.canPlaceOnSurfaces,
      backgroundTiles: base.backgroundTiles,
      canPlaceOnWalls: !!base.canPlaceOnWalls,
      mirrorSide: !!base.mirrorSide,
      furniturePath: `furniture/${dirName}/${fileName}`,
    }];
  }

  return (manifest.members ?? []).flatMap((member) =>
    flattenFurnitureManifest(member, dirName, {
      ...base,
      name: manifest.name ?? inherited.name,
    }),
  );
}

/** Pets in alphabetical folder order (their index is the layout's petType), as upstream loads them. */
async function buildPetIndex(petsDir) {
  const dirs = (await readdir(petsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(dirs.map(async (dir) => {
    const manifest = JSON.parse(await readFile(path.join(petsDir, dir, "manifest.json"), "utf8"));
    return { id: manifest.id, name: manifest.name, path: `pets/${dir}/pet.png` };
  }));
}

/** The asset index for an assets folder laid out like public/assets. */
export async function buildAssetIndex(assetsDir) {
  const furnitureRoot = path.join(assetsDir, "furniture");
  const furnitureDirs = await readdir(furnitureRoot, { withFileTypes: true });
  const furniture = [];
  for (const entry of furnitureDirs) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(furnitureRoot, entry.name, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    furniture.push(...flattenFurnitureManifest(manifest, entry.name));
  }

  return {
    characters: (await readdir(path.join(assetsDir, "characters")))
      .filter((name) => /^char_\d+\.png$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
      .map((name) => `characters/${name}`),
    floors: ["floors/floor_0.png", "floors/floor_1.png", "floors/floor_2.png", "floors/floor_3.png", "floors/floor_4.png", "floors/floor_5.png", "floors/floor_6.png", "floors/floor_7.png", "floors/floor_8.png"],
    walls: ["walls/wall_0.png"],
    carpets: (await readdir(path.join(assetsDir, "carpets")))
      .filter((name) => /^carpet_\d+\.png$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
      .map((name) => `carpets/${name}`),
    pets: await buildPetIndex(path.join(assetsDir, "pets")),
    furniture,
    layouts: {
      office: "default-layout-1.json",
      boardroomKitchen: "officesim-layout-boardroom-kitchen.json",
    },
    defaultLayout: "default-layout-1.json",
  };
}
