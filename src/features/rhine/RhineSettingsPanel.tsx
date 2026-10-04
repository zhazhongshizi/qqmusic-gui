import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  matchingPreset,
  presetLabels,
  qualityPresets,
  type QualityPreset,
  type RenderQuality,
} from "./vendor/render-quality";
import type { ArchiveRenderer, RhineFrameLimit, RhineSettings } from "./rhineSettings";
import { MvFallbackSetting } from "../player/MvPlaybackSettings";
import { SmartShuffleToggle } from "../player/SmartShuffleToggle";

type Choice = { value: string | number; label: string; disabled?: boolean };
type SettingsSection = "quality" | "details" | "playback" | "account";

function ChoiceField({
  label,
  value,
  choices,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string | number;
  choices: readonly Choice[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return <div className="rhine-setting-field">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={String(value)} disabled={disabled} onChange={event => onChange(event.target.value)}>
      {choices.map(choice => <option key={choice.value} value={String(choice.value)} disabled={choice.disabled}>{choice.label}</option>)}
    </select>
  </div>;
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  disabled = false,
  format = current => String(current),
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return <div className="rhine-setting-field rhine-setting-range">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      onChange={event => onChange(Number(event.target.value))} />
    <output htmlFor={id}>{format(value)}</output>
  </div>;
}

const presetChoices: readonly Choice[] = [
  { value: "performance", label: `${presetLabels.performance}画质` },
  { value: "original", label: `${presetLabels.original}画质` },
  { value: "high", label: `${presetLabels.high}画质` },
  { value: "ultra", label: `${presetLabels.ultra}画质` },
  { value: "custom", label: "自定义", disabled: true },
];

const sections: readonly { id: SettingsSection; label: string; index: string }[] = [
  { id: "quality", label: "性能画质", index: "01" },
  { id: "details", label: "详细参数", index: "02" },
  { id: "playback", label: "播放设置", index: "03" },
  { id: "account", label: "账号与界面", index: "04" },
];

export function RhineSettingsPanel({
  settings,
  backLabel,
  onQualityChange,
  onRendererChange,
  onFrameLimitChange,
  onSpatialUpscalingChange,
  onSuperPerformanceChange,
  onCassetteMotionChange,
  onReset,
  onClose,
  onAccount,
  onExit,
}: {
  settings: RhineSettings;
  backLabel: string;
  onQualityChange: (quality: RenderQuality) => void;
  onRendererChange: (renderer: ArchiveRenderer) => void;
  onFrameLimitChange: (frameLimit: RhineFrameLimit) => void;
  onSpatialUpscalingChange: (enabled: boolean) => void;
  onSuperPerformanceChange: (enabled: boolean) => void;
  onCassetteMotionChange: (mode: string) => void;
  onReset: () => void;
  onClose: () => void;
  onAccount: () => void;
  onExit: () => void;
}) {
  const titleId = useId();
  const [section, setSection] = useState<SettingsSection>("quality");
  const backButton = useRef<HTMLButtonElement>(null);
  const preset = matchingPreset(settings.quality);
  const superMode = settings.superPerformance;
  const is2D = settings.renderer === "canvas2d";

  useEffect(() => { backButton.current?.focus(); }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  function patch<K extends keyof RenderQuality>(field: K, value: RenderQuality[K]) {
    onQualityChange({ ...settings.quality, [field]: value });
  }

  return <section className="rhine-settings-page" aria-label="系统设置" onKeyDown={handleKeyDown}>
    <header className="rhine-settings-page-heading">
      <button ref={backButton} type="button" className="rhine-settings-back" onClick={onClose}>{backLabel}</button>
      <span className="rhine-eyebrow">SYSTEM / 系统设置</span>
    </header>
    <div className="rhine-settings-layout">
      <nav className="rhine-settings-nav" aria-label="设置分组">
        <span className="rhine-eyebrow">SETTINGS INDEX</span>
        {sections.map(item => <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined}
          onClick={() => setSection(item.id)}><small>{item.index}</small><span>{item.label}</span></button>)}
      </nav>
      <div className="rhine-settings-content" role="region" aria-labelledby={titleId}>
        {section === "quality" && <section className="rhine-settings-section">
          <div className="rhine-settings-section-heading">
            <div><p className="rhine-eyebrow">01 / QUALITY PROFILE</p><h2 id={titleId}>性能画质</h2></div>
            <button type="button" className="rhine-settings-reset" onClick={onReset}>恢复默认</button>
          </div>
          <ChoiceField label="阵列绘制方式" value={settings.renderer} choices={[{ value: "webgl", label: "3D · 原版" }, { value: "canvas2d", label: "2D · 试验版" }]}
            onChange={value => onRendererChange(value === "canvas2d" ? "canvas2d" : "webgl")} />
          <p className="rhine-settings-note">2D 试验版保留磁带阵列、抽取和播放起伏，采用近似的玻璃与阴影效果。可随时切回 3D 原版。</p>
          <ChoiceField label="画质预设" disabled={is2D} value={preset} choices={presetChoices} onChange={value => {
            if (value !== "custom") onQualityChange({ ...qualityPresets[value as QualityPreset] });
          }} />
          <label className="rhine-super-performance">
            <span><strong>超级性能模式</strong><small>保留阵列动效，同时降低三维渲染负载</small></span>
            <input type="checkbox" aria-label="超级性能模式" disabled={is2D} checked={superMode} onChange={event => onSuperPerformanceChange(event.target.checked)} />
          </label>
          <ChoiceField label="播放磁带动效" value={settings.disableCassetteMotionWhilePlaying ? "disabled" : settings.reduceCassetteMotionWhilePlaying ? "reduced" : "full"}
            choices={[{ value: "full", label: "完整" }, { value: "reduced", label: "减少" }, { value: "disabled", label: "禁用" }]}
            onChange={onCassetteMotionChange} />
          <p className="rhine-settings-note">完整：持续起伏。减少：保留插入和切歌涟漪，随后转为轻微缓慢起伏。禁用：关闭起伏，保留插入、升起和切歌动作。三档均继续播放音乐。</p>
          <p className="rhine-settings-note">设置会即时应用并在下次启动时恢复。{is2D ? "3D 画质参数暂不生效，切回原版后恢复。" : "开启超级性能模式后，后处理和透明材质选项会暂时停用，关闭后恢复。"}</p>
        </section>}

        {section === "details" && <section className="rhine-settings-section">
          <div className="rhine-settings-section-heading">
            <div><p className="rhine-eyebrow">02 / CUSTOM PARAMETERS</p><h2 id={titleId}>详细性能参数</h2></div>
            <button type="button" className="rhine-settings-reset" onClick={onReset}>恢复默认</button>
          </div>
          <ChoiceField label="帧数限制" value={settings.frameLimit} choices={[{ value: 30, label: "30 帧" }, { value: 60, label: "60 帧" }, { value: 0, label: "无上限" }]}
            onChange={value => onFrameLimitChange(Number(value) as RhineFrameLimit)} />
          <p className="rhine-settings-note">帧数限制同时用于 3D 和 2D 阵列，调整后即时保存。无上限时跟随屏幕刷新率。</p>
          <label className="rhine-super-performance">
            <span><strong>空间超分（FSR 1 · 试验）</strong><small>降低场景分辨率，再放大并锐化</small></span>
            <input type="checkbox" aria-label="空间超分（FSR 1 · 试验）" disabled={is2D || superMode} checked={settings.spatialUpscaling} onChange={event => onSpatialUpscalingChange(event.target.checked)} />
          </label>
          <p className="rhine-settings-note">仅用于普通 3D 模式，默认关闭。场景以最高约 67% 的宽高绘制，文字和按钮保持原分辨率；切换到 2D 或超级性能模式时暂停生效。画质和性能收益取决于设备。</p>
          <p className="rhine-settings-note">以下 9 项画质参数用于 3D 原版。超级性能模式会停用抗锯齿、环境遮蔽、景深和透明材质分辨率。</p>
          {is2D && <p className="rhine-settings-note">2D 试验版自动限制绘制分辨率，原 3D 画质参数保留。</p>}
          <fieldset className="rhine-settings-grid" disabled={is2D} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <RangeField label="三维渲染比例" value={settings.quality.scale} min={50} max={200} step={5} format={value => `${value}%`} onChange={value => patch("scale", value)} />
            <ChoiceField label="像素密度上限" value={settings.quality.pixelRatio} choices={[1, 1.5, 2, 3].map(value => ({ value, label: `${value}×` }))} onChange={value => patch("pixelRatio", Number(value) as RenderQuality["pixelRatio"])} />
            <ChoiceField label="抗锯齿" disabled={superMode} value={settings.quality.antialias} choices={[{ value: "off", label: "关闭" }, { value: "smaa", label: "SMAA" }]} onChange={value => patch("antialias", value as RenderQuality["antialias"])} />
            <ChoiceField label="阴影分辨率" value={settings.quality.shadows} choices={[0, 1024, 2048, 4096].map(value => ({ value, label: value ? `${value}` : "关闭" }))} onChange={value => patch("shadows", Number(value))} />
            <ChoiceField label="环境遮蔽采样" disabled={superMode} value={settings.quality.aoSamples} choices={[0, 16, 32, 64].map(value => ({ value, label: value ? `${value} samples` : "关闭" }))} onChange={value => patch("aoSamples", Number(value))} />
            <ChoiceField label="遮蔽分辨率" disabled={superMode} value={settings.quality.aoResolution} choices={[0.5, 0.75, 1].map(value => ({ value, label: `${value * 100}%` }))} onChange={value => patch("aoResolution", Number(value))} />
            <RangeField label="景深强度" disabled={superMode} value={settings.quality.depthOfField} min={0} max={150} step={5} format={value => `${value}%`} onChange={value => patch("depthOfField", value)} />
            <ChoiceField label="透明材质分辨率" disabled={superMode} value={settings.quality.transmission} choices={[0.25, 0.5, 0.75, 1].map(value => ({ value, label: `${value * 100}%` }))} onChange={value => patch("transmission", Number(value))} />
            <ChoiceField label="纹理过滤" value={settings.quality.anisotropy} choices={[1, 2, 4, 8, 16].map(value => ({ value, label: `${value}×` }))} onChange={value => patch("anisotropy", Number(value))} />
          </fieldset>
        </section>}

        {section === "playback" && <section className="rhine-settings-section">
          <div className="rhine-settings-section-heading">
            <div><p className="rhine-eyebrow">03 / PLAYBACK</p><h2 id={titleId}>播放设置</h2></div>
          </div>
          <SmartShuffleToggle presentation="rhine" />
        </section>}

        {section === "account" && <section className="rhine-settings-section">
          <MvFallbackSetting />
          <div className="rhine-settings-section-heading">
            <div><p className="rhine-eyebrow">04 / ACCOUNT & NAVIGATION</p><h2 id={titleId}>账号与界面</h2></div>
          </div>
          <p className="rhine-settings-note">账号管理沿用主界面的现有流程；切换界面会返回主模式。</p>
          <div className="rhine-settings-account-actions">
            <button type="button" onClick={onAccount}><span>账号设置</span><small>登录状态与账号管理 ↗</small></button>
            <button type="button" onClick={onExit}><span>返回主界面</span><small>切换至轻量主模式 ↗</small></button>
          </div>
        </section>}
      </div>
    </div>
  </section>;
}
