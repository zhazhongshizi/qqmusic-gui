import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ListeningAnalytics } from "./ListeningAnalytics";
import { ListeningStatistics } from "./ListeningStatistics";
import { beginPlaybackSession, installPlaybackTransport, notifyPlaybackReconnected } from "../../backend/playbackTransport";
import { parseAnalytics, type Analytics } from "../../backend/analyticsAdapter";
import { chartPoints, localDate, presetRange, validRange } from "./analyticsDates";

export function analyticsFixture(start="2026-10-01",end="2026-10-08"): Analytics {
  return {startDate:start,endDate:end,totalMs:60000,qualifiedPlays:2,tracks:1,lifetimeMs:120000,lifetimePlays:4,upgradedMs:1,retainedFromMs:1,storageAvailable:true,
    days:[{date:end,listenedMs:60000,qualifiedPlays:2}],hours:[{hour:12,listenedMs:60000,qualifiedPlays:2}],
    songs:[{id:"a",title:"测试曲目",artist:"测试歌手",listenedMs:60000,qualifiedPlays:2}],artists:[{artist:"测试歌手",tracks:1,listenedMs:60000,qualifiedPlays:2}],likes:null};
}
function transportFixture(_command:string,payload?:Record<string,unknown>) {
  const r=payload!.request as {startDate:string;endDate:string};return Promise.resolve(analyticsFixture(r.startDate,r.endDate));
}
afterEach(()=>{cleanup();installPlaybackTransport(null);vi.useRealTimers();vi.restoreAllMocks();});
it("本地日期预设和闰年范围不会用固定毫秒跨天，分组保持总量",()=>{
  expect(presetRange("week",new Date(2026,0,2))).toEqual({start:"2025-12-27",end:"2026-01-02"});
  expect(presetRange("year",new Date(2026,9,8)).start).toBe("2026-01-01");
  expect(validRange("2024-01-01","2024-12-31")).toBe(true);
  expect(validRange("2026-02-30","2026-03-02")).toBe(false);
  expect(validRange("2025-01-01","2026-12-31")).toBe(false);
  for(const grain of ["day","week","month"] as const)expect(chartPoints(analyticsFixture(),grain).reduce((sum,r)=>sum+r.listenedMs,0)).toBe(60000);
  expect(chartPoints(analyticsFixture(),"day")).toHaveLength(8);
});
it("校验后端图表范围、数值和榜单上限",()=>{
  const data=analyticsFixture();expect(parseAnalytics(data)).toEqual(data);
  expect(()=>parseAnalytics({...data,totalMs:-1})).toThrow();
  expect(()=>parseAnalytics({...data,hours:[{hour:24,listenedMs:0,qualifiedPlays:0}]})).toThrow();
  expect(()=>parseAnalytics({...data,songs:Array(31).fill(data.songs[0])})).toThrow();
  expect(()=>parseAnalytics({...data,days:[{date:"2026-09-01",listenedMs:0,qualifiedPlays:0}]})).toThrow();
});
it("默认入口显示分析、榜单及未知收藏，图表可聚焦并切换粒度",async()=>{
  installPlaybackTransport(transportFixture);render(<ListeningStatistics/>);
  await screen.findByText("测试曲目");expect(screen.getByText(/喜欢列表尚未载入/)).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"数据分析"})).toHaveAttribute("aria-pressed","true");
  fireEvent.change(screen.getByLabelText("聚合粒度"),{target:{value:"month"}});
  const chart=screen.getByRole("group",{name:"收听时长趋势图"});
  fireEvent.focus(within(chart).getAllByRole("img")[0]!);
  expect(chart.parentElement).toHaveTextContent("2 次有效收听");
  fireEvent.click(screen.getByRole("button",{name:"折线图"}));expect(chart.querySelector("polyline")).not.toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"收听记录与队列"}));expect(screen.getByRole("button",{name:"今天"})).toBeInTheDocument();
});
it("自定义日期校验、空状态和错误重试",async()=>{
  const transport=vi.fn(transportFixture);installPlaybackTransport(transport);render(<ListeningAnalytics/>);await screen.findByText("测试曲目");
  fireEvent.change(screen.getByLabelText("开始日期"),{target:{value:"2027-01-01"}});fireEvent.click(screen.getByRole("button",{name:"应用日期"}));
  expect(screen.getByRole("alert")).toHaveTextContent("最多 366 天");expect(transport).toHaveBeenCalledTimes(1);
  transport.mockRejectedValueOnce(new Error("offline"));fireEvent.click(screen.getByRole("button",{name:"刷新分析"}));await screen.findByText(/分析读取失败/);
  transport.mockImplementationOnce(async(c,p)=>({...await transportFixture(c,p),totalMs:0,qualifiedPlays:0,tracks:0,days:[],hours:[],songs:[],artists:[]}));
  fireEvent.click(screen.getByRole("button",{name:"重试分析"}));await screen.findByText(/所选区间没有已保存/);
});
it("日期与会话变化后忽略旧响应",async()=>{
  let resolveOld!:(v:unknown)=>void;
  installPlaybackTransport(()=>new Promise(resolve=>{resolveOld=resolve;}));render(<ListeningAnalytics/>);
  const month=presetRange("month");
  installPlaybackTransport(async(c,p)=>({...await transportFixture(c,p),songs:[{id:"b",title:"新会话歌曲",artist:"B",listenedMs:1,qualifiedPlays:0}]}));
  act(()=>{beginPlaybackSession();notifyPlaybackReconnected();});
  await screen.findByText("新会话歌曲");
  await act(async()=>resolveOld(analyticsFixture(month.start,month.end)));expect(screen.queryByText("测试曲目")).toBeNull();
  fireEvent.change(screen.getByLabelText("开始日期"),{target:{value:"2025-06-01"}});fireEvent.change(screen.getByLabelText("结束日期"),{target:{value:"2025-06-30"}});
  fireEvent.click(screen.getByRole("button",{name:"应用日期"}));await screen.findByText("新会话歌曲");expect(screen.getByText(/统计区间：2025-06-01/)).toBeInTheDocument();
});
it("仅可见页面每分钟刷新，卸载停止",async()=>{
  vi.useFakeTimers();const visibility=vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
  const transport=vi.fn(transportFixture);installPlaybackTransport(transport);const view=render(<ListeningAnalytics/>);await act(async()=>{});
  expect(transport).toHaveBeenCalledTimes(1);await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect(transport).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("hidden");await act(async()=>{await vi.advanceTimersByTimeAsync(120000);});expect(transport).toHaveBeenCalledTimes(2);
  view.unmount();await vi.advanceTimersByTimeAsync(60000);expect(transport).toHaveBeenCalledTimes(2);
});
it("预设跨本地午夜会更新日期范围",async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,8,23,59,30));vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
  const transport=vi.fn(transportFixture);installPlaybackTransport(transport);render(<ListeningAnalytics/>);await act(async()=>{});
  await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
  expect(transport).toHaveBeenLastCalledWith("personal_library",{request:{action:"listeningAnalytics",startDate:"2026-10-01",endDate:localDate()}});
});
