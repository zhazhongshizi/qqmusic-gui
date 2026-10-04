import { useRef, useState } from "react";
import { changeCollections, type Bookmark } from "../../backend/personalAdapter";
import { hasPlaybackTransport } from "../../backend/playbackTransport";
import { useCollections } from "./useCollections";
export { useCollections } from "./useCollections";
export { SavedQueues } from "./SavedQueues";
export { PersonalLibrary } from "./BookmarkLibrary";
export function BookmarkButton({kind,id,title,coverCacheKey}:Bookmark) {
  const {data,error,refresh}=useCollections();const [busy,setBusy]=useState(false);const [notice,setNotice]=useState("");const pending=useRef(false);
  const saved=!!data?.bookmarks.some(item=>item.kind===kind&&item.id===id);
  async function toggle(){if(pending.current)return;pending.current=true;setBusy(true);setNotice("");try{await changeCollections({action:"bookmark",kind,id,title,saved:!saved,...(coverCacheKey?{coverCacheKey}:{})});}catch{setNotice("书签保存失败，请重试");}finally{pending.current=false;setBusy(false);}}
  return <div className="bookmark-control"><button type="button" className="text-button" aria-pressed={saved} disabled={busy||!data||!hasPlaybackTransport()} onClick={()=>void toggle()}>{saved?"已加入资料库":"加入我的资料库"}</button>{error&&hasPlaybackTransport()&&<button type="button" onClick={refresh}>重试读取书签</button>}<span role="status">{notice}</span></div>;
}
