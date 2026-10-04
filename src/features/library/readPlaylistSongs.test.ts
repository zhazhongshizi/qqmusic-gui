import { beforeEach, expect, it, vi } from "vitest";
import { readPlaylistSongs, invalidatePlaylistSongs } from "./readPlaylistSongs";
import { beginPlaybackSession } from "../../backend/playbackTransport";
import { updateCatalogAccount } from "../../backend/catalogCacheScope";
const read = vi.hoisted(() => vi.fn());
vi.mock("../../backend/catalogAdapter", () => ({ getPlaylistSongs: read }));
beforeEach(() => { read.mockReset(); invalidatePlaylistSongs(); });
it("shares a bounded ordered read and stops after cancellation", async () => {
  let current = true;
  read.mockImplementation(async (_id, _generation, page) => {
    if (page === 2) current = false;
    return { hasMore: true, items: [{ id: String(page) }] };
  });
  await expect(readPlaylistSongs({ id: "playlist" }, 7, () => current)).resolves.toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
});
it("rejects an endless upstream playlist at 100 pages", async () => {
  read.mockResolvedValue({ hasMore: true, items: [] });
  await expect(readPlaylistSongs({ id: "playlist" }, 7, () => true)).rejects.toThrow("playlist_page_limit");
  expect(read).toHaveBeenCalledTimes(100);
});
it("reuses full reads across openings and refetches after refresh, expiry and connection changes",async()=>{
  read.mockResolvedValue({hasMore:false,items:[{id:"a"}]});
  const first=await readPlaylistSongs({id:"cached"},1,()=>true);
  expect(await readPlaylistSongs({id:"cached"},2,()=>true)).toEqual(first);expect(read).toHaveBeenCalledTimes(1);
  invalidatePlaylistSongs({id:"cached"});await readPlaylistSongs({id:"cached"},3,()=>true);expect(read).toHaveBeenCalledTimes(2);
  const time=vi.spyOn(Date,"now").mockReturnValue(Date.now()+300_001);
  await readPlaylistSongs({id:"cached"},4,()=>true);expect(read).toHaveBeenCalledTimes(3);time.mockRestore();
  beginPlaybackSession();await readPlaylistSongs({id:"cached"},5,()=>true);expect(read).toHaveBeenCalledTimes(4);
});
it("a refreshed or cancelled late read cannot repopulate the cache",async()=>{
  let resolve!:(value:unknown)=>void;
  read.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const pending=readPlaylistSongs({id:"late"},1,()=>true);
  invalidatePlaylistSongs({id:"late"});resolve({hasMore:false,items:[{id:"old"}]});
  expect(await pending).toBeNull();
  read.mockResolvedValue({hasMore:false,items:[{id:"new"}]});
  expect(await readPlaylistSongs({id:"late"},2,()=>true)).toEqual([{id:"new"}]);
});
it("keeps cache for the same account and refetches after account changes",async()=>{
  read.mockResolvedValue({hasMore:false,items:[{id:"account-track"}]});
  updateCatalogAccount("account-a");await readPlaylistSongs({id:"private-list"},1,()=>true);
  updateCatalogAccount("account-a");await readPlaylistSongs({id:"private-list"},2,()=>true);expect(read).toHaveBeenCalledTimes(1);
  updateCatalogAccount("account-b");await readPlaylistSongs({id:"private-list"},3,()=>true);expect(read).toHaveBeenCalledTimes(2);
});
