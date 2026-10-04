import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const setStageActive = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./spectrumStore", () => ({ setSpectrumStageActive: setStageActive }));

import { SpectrumBridge } from "./SpectrumBridge";

async function flushCommands() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SpectrumBridge", () => {
  afterEach(() => {
    setStageActive.mockReset().mockResolvedValue(undefined);
  });

  it("serializes active changes and always releases on unmount", async () => {
    const view = render(<SpectrumBridge active />);
    await flushCommands();
    expect(setStageActive).toHaveBeenLastCalledWith(true);

    view.rerender(<SpectrumBridge active={false} />);
    await flushCommands();
    expect(setStageActive).toHaveBeenLastCalledWith(false);
    expect(setStageActive.mock.calls.map(([active]) => active)).toEqual([true, false]);

    view.unmount();
    await flushCommands();
    expect(setStageActive).toHaveBeenLastCalledWith(false);
  });
});
