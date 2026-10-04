export interface LyricLine {
  atMs: number;
  original: string;
  translation?: string;
  romanized?: string;
}

export type ActualQuality = "FLAC" | "MP3" | "MP3 320k" | "MP3 128k" | "OGG" | "QQ MV 音轨" | "未知音质";

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  actualQuality: ActualQuality;
  expectedQuality: "无损" | "高品质" | "标准";
  accent: string;
  artworkVariant: "fern" | "moon" | "tide" | "train" | "mist";
  coverCacheKey?: string;
  lyrics: readonly LyricLine[];
}

export const FIXTURE_TRACKS: readonly Track[] = [
  {
    id: "fixture-dusk-greenhouse",
    title: "暮色温室",
    artist: "林间频率",
    album: "黑胶温室录音",
    durationMs: 248_000,
    actualQuality: "FLAC",
    expectedQuality: "无损",
    accent: "#789575",
    artworkVariant: "fern",
    lyrics: [
      { atMs: 0, original: "玻璃上的雨，替黄昏调低了音量" },
      { atMs: 46_000, original: "唱针落下，森林从纹路里生长" },
      {
        atMs: 102_000,
        original: "把没有寄出的晚风，留在这一面窗",
        translation: "Leave the unsent evening breeze by this window",
        romanized: "bǎ méi yǒu jì chū de wǎn fēng · liú zài zhè yī miàn chuāng",
      },
      { atMs: 161_000, original: "当灯火转身，我们仍听见微光" },
      { atMs: 216_000, original: "下一圈年轮，会记得今晚" },
    ],
  },
  {
    id: "fixture-paper-moon",
    title: "纸月光",
    artist: "方格岛",
    album: "夜航手册",
    durationMs: 221_000,
    actualQuality: "MP3 320k",
    expectedQuality: "无损",
    accent: "#9f9878",
    artworkVariant: "moon",
    lyrics: [
      { atMs: 0, original: "折一枚安静的月亮" },
      { atMs: 61_000, original: "放进凌晨的口袋" },
      { atMs: 122_000, original: "街灯沿着纸边醒来" },
      { atMs: 177_000, original: "我们向着没有名字的海" },
    ],
  },
  {
    id: "fixture-tidal-letter",
    title: "潮汐来信",
    artist: "远岸合唱团",
    album: "蓝色邮局",
    durationMs: 276_000,
    actualQuality: "FLAC",
    expectedQuality: "无损",
    accent: "#61858b",
    artworkVariant: "tide",
    lyrics: [
      { atMs: 0, original: "海把信封推回岸边" },
      { atMs: 79_000, original: "盐粒写下迟到的落款" },
      { atMs: 142_000, original: "你说远方只是一种回声" },
      { atMs: 211_000, original: "而我正站在回声中间" },
    ],
  },
  {
    id: "fixture-after-rain-train",
    title: "雨后列车",
    artist: "纬线电台",
    album: "慢速经过",
    durationMs: 194_000,
    actualQuality: "MP3 320k",
    expectedQuality: "高品质",
    accent: "#8c765e",
    artworkVariant: "train",
    lyrics: [
      { atMs: 0, original: "车窗收好最后一场雨" },
      { atMs: 54_000, original: "站台向后退成细线" },
      { atMs: 113_000, original: "有人在下一站等天气放晴" },
      { atMs: 163_000, original: "有人只想多坐一程" },
    ],
  },
  {
    id: "fixture-south-window-mist",
    title: "南窗雾",
    artist: "空房间",
    album: "植物标本",
    durationMs: 235_000,
    actualQuality: "MP3 128k",
    expectedQuality: "标准",
    accent: "#72847c",
    artworkVariant: "mist",
    lyrics: [
      { atMs: 0, original: "雾沿着南窗慢慢升高" },
      { atMs: 67_000, original: "抹去城市匆忙的笔画" },
      { atMs: 131_000, original: "一盆绿意守住早晨" },
      { atMs: 198_000, original: "等光把房间重新命名" },
    ],
  },
];

