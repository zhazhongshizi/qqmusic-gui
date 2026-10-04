import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import {readSearchHistory,rememberSearch,SearchHistory,writeSearchHistory} from "./searchHistory";
beforeEach(()=>localStorage.clear());afterEach(cleanup);
it("迁移莱茵记录、保留分类、去重并限制十条，清空不会恢复旧记录",()=>{
  localStorage.setItem("qqmusic_rhine_search_history",JSON.stringify(["旧词"]));
  expect(readSearchHistory()).toEqual([{query:"旧词",type:"songs"}]);
  rememberSearch("旧词","albums");rememberSearch("旧词","artists");rememberSearch("旧词","albums");
  expect(readSearchHistory().slice(0,2)).toEqual([{query:"旧词",type:"albums"},{query:"旧词",type:"artists"}]);
  for(let i=0;i<12;i++)rememberSearch(String(i),"songs");expect(readSearchHistory()).toHaveLength(10);
  writeSearchHistory([]);expect(readSearchHistory()).toEqual([]);expect(localStorage.getItem("qqmusic_rhine_search_history")).toBeNull();
});
it("两个界面即时共享分类历史并可清空",()=>{
  rememberSearch("周杰伦","artists");const select=vi.fn();render(<SearchHistory onSelect={select}/>);
  fireEvent.click(screen.getByRole("button",{name:"周杰伦 歌手"}));expect(select).toHaveBeenCalledWith({query:"周杰伦",type:"artists"});
  fireEvent.click(screen.getByRole("button",{name:"清空搜索历史"}));expect(screen.queryByText("周杰伦")).toBeNull();
});
it("损坏和未知分类记录不会进入界面",()=>{
  localStorage.setItem("qqmusic_search_history_v1",JSON.stringify([{query:"正常",type:"songs"},{query:"非法",type:"unknown"},{query:"坏\n词",type:"albums"}]));
  expect(readSearchHistory()).toEqual([{query:"正常",type:"songs"}]);
});
