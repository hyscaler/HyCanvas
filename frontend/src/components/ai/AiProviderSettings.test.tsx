// @vitest-environment jsdom

// Regression cover for the provider settings form.
//
// Every case here is a bug that shipped and was found by hand: the form
// claiming a stored key for a provider that had none, an image provider losing
// its model and host on a round trip through the select, and a section that
// hid itself when its fetch failed so a broken backend looked like a missing
// feature. Each was cheap to introduce and invisible in a type check, which is
// exactly the class of defect a rendering test earns its keep on.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, type AiConfigView, type AiProviderPreset } from "@hc/sdk";

const oc = {
  getSearchConfig: vi.fn(),
  getAiImageConfig: vi.fn(),
  setAiConfig: vi.fn(),
  setSearchConfig: vi.fn(),
  setAiImageConfig: vi.fn(),
  deleteAiConfig: vi.fn(),
  deleteAiImageConfig: vi.fn(),
  testAiImageConfig: vi.fn(),
  testAiConfig: vi.fn(),
};
vi.mock("@/lib/sdk", () => ({ oc }));

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock("@/components/ui/Toast", () => ({ useToast: () => toast }));

const confirmAction = vi.fn<(opts: { title: string; message: string }) => Promise<boolean>>(async () => true);
vi.mock("@/lib/promptDialog", () => ({ confirmAction }));

const { AiProviderSettings } = await import("./AiProviderSettings");

const caps = (image: boolean) => ({ text: true, image, describeImage: false, editImage: false });
const PRESETS: AiProviderPreset[] = [
  { id: "bedrock", label: "Amazon Bedrock", baseUrl: "", defaultModel: "anthropic.claude-sonnet-4-5-20250929-v1:0", defaultImageModel: "amazon.nova-canvas-v1:0", capabilities: caps(true), needsBaseUrl: true, needsSecret: true },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", defaultImageModel: "dall-e-3", capabilities: caps(true) },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", capabilities: caps(false) },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", defaultModel: "llama", defaultImageModel: "flux", capabilities: caps(true) },
] as AiProviderPreset[];

const storedConfig: AiConfigView = {
  provider: "openai",
  model: "gpt-4o-mini",
  imageModel: null,
  baseUrl: null,
  hasKey: true,
  capabilities: caps(true),
};

function renderForm(config: AiConfigView | null = storedConfig) {
  return render(
    <AiProviderSettings
      workspaceId="ws-1"
      config={config}
      presets={PRESETS}
      canEdit
      layout="wide"
      onSaved={() => {}}
    />,
  );
}

/** The image provider section, once its record has loaded. */
const imageSection = () => screen.getByRole("group", { name: "Image provider" });

/** A field from the MAIN provider form.
 *
 *  The image section has its own "Provider" and "API key" controls, which is
 *  correct: they are the same concepts for a different vendor. Assistive tech
 *  tells them apart by the image section's fieldset legend, so the equivalent
 *  here is to take the control that is not inside that group. */
function mainField(label: string): HTMLElement {
  const group = screen.queryByRole("group", { name: "Image provider" });
  const match = screen.getAllByLabelText(label).find((el) => !group?.contains(el));
  if (!match) throw new Error(`no main-form field labelled "${label}"`);
  return match;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  oc.getSearchConfig.mockResolvedValue(null);
  oc.getAiImageConfig.mockResolvedValue(null);
  oc.testAiConfig.mockResolvedValue(undefined);
  oc.testAiImageConfig.mockResolvedValue({ verified: true });
  confirmAction.mockResolvedValue(true);
});

describe("the stored API key", () => {
  it("is shown as a masked stand-in for the provider it belongs to", async () => {
    renderForm();
    expect(await screen.findByRole("button", { name: "Replace" })).toBeTruthy();
  });

  it("stops claiming a key once a different provider is selected", async () => {
    renderForm();
    await screen.findByRole("button", { name: "Replace" });

    // The stored key belongs to OpenAI. Switching to DeepSeek must not imply
    // DeepSeek has one: the save would be refused, and before the fix the only
    // sign was a toast after the round trip.
    fireEvent.change(mainField("Provider"), { target: { value: "deepseek" } });

    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    const key = mainField("API key") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    // And it asks for a key rather than offering to keep one.
    expect(key.placeholder).toBe("API key");
  });

  it("restores the masked stand-in when the stored provider is selected again", async () => {
    renderForm();
    await screen.findByRole("button", { name: "Replace" });
    fireEvent.change(mainField("Provider"), { target: { value: "deepseek" } });
    fireEvent.change(mainField("Provider"), { target: { value: "openai" } });
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
  });
});

describe("a provider that signs its requests", () => {
  it("asks for a secret access key, and only for the provider that needs one", async () => {
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    // OpenAI is selected: no second credential exists for it.
    expect(screen.queryByLabelText("Secret access key")).toBeNull();

    fireEvent.change(mainField("Provider"), { target: { value: "bedrock" } });
    expect(mainField("Secret access key")).toBeTruthy();
  });

  it("refuses to save a signing provider with only half its credential", async () => {
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.change(mainField("Provider"), { target: { value: "bedrock" } });
    fireEvent.change(mainField("API key"), { target: { value: "AKIDEXAMPLE" } });
    fireEvent.change(mainField("Base URL"), { target: { value: "https://bedrock-runtime.us-east-1.amazonaws.com" } });

    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    // An access key ID alone cannot produce a signature, so this never reaches
    // the server.
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(oc.setAiConfig).not.toHaveBeenCalled();
  });

  it("sends both halves when both are given", async () => {
    oc.setAiConfig.mockResolvedValue(storedConfig);
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.change(mainField("Provider"), { target: { value: "bedrock" } });
    fireEvent.change(mainField("API key"), { target: { value: "AKIDEXAMPLE" } });
    fireEvent.change(mainField("Secret access key"), { target: { value: "secret" } });
    fireEvent.change(mainField("Base URL"), { target: { value: "https://bedrock-runtime.us-east-1.amazonaws.com" } });

    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() =>
      expect(oc.setAiConfig).toHaveBeenCalledWith("ws-1", expect.objectContaining({
        provider: "bedrock", apiKey: "AKIDEXAMPLE", apiSecret: "secret",
      })),
    );
  });

  it("can be chosen as the IMAGE provider, secret and all", async () => {
    oc.getAiImageConfig.mockResolvedValue(null);
    oc.setAiConfig.mockResolvedValue(storedConfig);
    oc.setAiImageConfig.mockResolvedValue({ provider: "bedrock", model: null, baseUrl: null, hasKey: true, hasSecret: true, capabilities: caps(true) });
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));

    // Bedrock generates images, so it is offered here; before the fix it was
    // offered with nowhere to put the second half of its credential, and every
    // save was refused with no way to satisfy it.
    fireEvent.change(section.getByLabelText("Provider"), { target: { value: "bedrock" } });
    fireEvent.change(section.getByLabelText("API key"), { target: { value: "AKIDEXAMPLE" } });
    fireEvent.change(section.getByLabelText("Secret access key"), { target: { value: "secret" } });
    fireEvent.change(section.getByLabelText("Base URL"), { target: { value: "https://bedrock-runtime.us-east-1.amazonaws.com" } });

    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() =>
      expect(oc.setAiImageConfig).toHaveBeenCalledWith("ws-1", expect.objectContaining({
        provider: "bedrock", apiKey: "AKIDEXAMPLE", apiSecret: "secret",
      })),
    );
  });

  it("refuses an image provider missing half its credential", async () => {
    oc.getAiImageConfig.mockResolvedValue(null);
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));
    fireEvent.change(section.getByLabelText("Provider"), { target: { value: "bedrock" } });
    fireEvent.change(section.getByLabelText("API key"), { target: { value: "AKIDEXAMPLE" } });
    fireEvent.change(section.getByLabelText("Base URL"), { target: { value: "https://bedrock-runtime.us-east-1.amazonaws.com" } });

    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(oc.setAiImageConfig).not.toHaveBeenCalled();
  });

  it("never carries a secret across a provider switch", async () => {
    oc.setAiConfig.mockResolvedValue(storedConfig);
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.change(mainField("Provider"), { target: { value: "bedrock" } });
    fireEvent.change(mainField("Secret access key"), { target: { value: "aws-secret" } });
    // Away to a provider with no secret, and back.
    fireEvent.change(mainField("Provider"), { target: { value: "deepseek" } });
    fireEvent.change(mainField("Provider"), { target: { value: "bedrock" } });
    expect((mainField("Secret access key") as HTMLInputElement).value).toBe("");
  });
});

describe("the image provider", () => {
  it("keeps its stored model and host across a round trip through the select", async () => {
    oc.getAiImageConfig.mockResolvedValue({
      provider: "openai",
      model: "dall-e-3",
      baseUrl: "https://images.example.com/v1",
      hasKey: true,
      capabilities: caps(true),
    });
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));

    const select = section.getByLabelText("Provider");
    fireEvent.change(select, { target: { value: "together" } });
    // Another provider's model and host must not ride along.
    expect((section.getByLabelText("Image model (optional)") as HTMLInputElement).value).toBe("");
    expect((section.getByLabelText("Base URL") as HTMLInputElement).value).toBe("");

    fireEvent.change(select, { target: { value: "openai" } });
    // Coming back restores what was STORED. Restoring the live values instead
    // returned the blanks the switch had just written, silently dropping a
    // configured model and a required custom host.
    expect((section.getByLabelText("Image model (optional)") as HTMLInputElement).value).toBe("dall-e-3");
    expect((section.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://images.example.com/v1");
  });

  it("offers only providers that can actually generate images", async () => {
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    const options = within(imageSection()).getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("OpenAI");
    expect(options).toContain("Together AI");
    expect(options).not.toContain("DeepSeek");
  });

  it("explains what is lost when the text provider cannot make images", async () => {
    renderForm({ ...storedConfig, provider: "deepseek", capabilities: caps(false) });
    const section = within(await screen.findByRole("group", { name: "Image provider" }));
    expect(section.getByText(/DeepSeek cannot generate images/)).toBeTruthy();
  });

  it("reports an unverifiable key as unverified, not as broken", async () => {
    oc.getAiImageConfig.mockResolvedValue({ provider: "openai", model: null, baseUrl: null, hasKey: true, capabilities: caps(true) });
    // A provider with no model listing answers nothing conclusive. Calling that
    // a failure would send an admin to replace a key that is perfectly good.
    oc.testAiImageConfig.mockResolvedValue({ verified: false });
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));

    fireEvent.click(section.getByRole("button", { name: "Test" }));
    expect(await section.findByText(/Could not verify/)).toBeTruthy();
  });

  it("reports a rejected key as not working, with the provider's reason", async () => {
    oc.getAiImageConfig.mockResolvedValue({ provider: "openai", model: null, baseUrl: null, hasKey: true, capabilities: caps(true) });
    oc.testAiImageConfig.mockRejectedValue(new Error("nope"));
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));

    // Untested but saved reads as neither working nor broken.
    expect(section.getByText("Key saved: OpenAI")).toBeTruthy();

    fireEvent.click(section.getByRole("button", { name: "Test" }));
    expect(await section.findByText("OpenAI is not working")).toBeTruthy();
    expect(section.getByText("The image provider did not answer.")).toBeTruthy();
  });

  it("confirms a key the provider accepts, and forgets it when the provider changes", async () => {
    oc.getAiImageConfig.mockResolvedValue({ provider: "openai", model: null, baseUrl: null, hasKey: true, capabilities: caps(true) });
    oc.testAiImageConfig.mockResolvedValue({ verified: true });
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));

    fireEvent.click(section.getByRole("button", { name: "Test" }));
    expect(await section.findByText("Working: OpenAI")).toBeTruthy();

    // The verdict was about the provider that was selected when it was made.
    fireEvent.change(section.getByLabelText("Provider"), { target: { value: "together" } });
    expect(screen.queryByText("Working: OpenAI")).toBeNull();
  });

  it("says so when its record could not be read, instead of vanishing", async () => {
    oc.getAiImageConfig.mockRejectedValue(new Error("404"));
    renderForm();
    expect(await screen.findByText(/Image provider settings could not be loaded/)).toBeTruthy();
    // The fields stay hidden: offering to save a value we never read is how a
    // stored config gets wiped.
    expect(screen.queryByRole("group", { name: "Image provider" })).toBeNull();
  });
});

describe("saving", () => {
  it("does not touch the optional records whose fetch failed", async () => {
    oc.getSearchConfig.mockRejectedValue(new Error("boom"));
    oc.getAiImageConfig.mockRejectedValue(new Error("boom"));
    oc.setAiConfig.mockResolvedValue(storedConfig);
    renderForm();
    await screen.findByText(/Web search settings could not be loaded/);

    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(oc.setAiConfig).toHaveBeenCalledTimes(1));
    // Sending provider:"" for a record we never loaded would clear a configured
    // search or image provider the user never touched.
    expect(oc.setSearchConfig).not.toHaveBeenCalled();
    expect(oc.setAiImageConfig).not.toHaveBeenCalled();
  });

  it("writes nothing for an image provider that neither exists nor was chosen", async () => {
    oc.getAiImageConfig.mockResolvedValue(null);
    oc.setAiConfig.mockResolvedValue(storedConfig);
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });

    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(oc.setAiConfig).toHaveBeenCalledTimes(1));
    // An empty provider over an absent row is a DELETE for something that was
    // never there, once per save.
    expect(oc.setAiImageConfig).not.toHaveBeenCalled();
  });

  it("still sends the empty provider when one is being cleared", async () => {
    oc.getAiImageConfig.mockResolvedValue({ provider: "openai", model: null, baseUrl: null, hasKey: true, capabilities: caps(true) });
    oc.setAiConfig.mockResolvedValue(storedConfig);
    oc.setAiImageConfig.mockResolvedValue(null);
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));

    fireEvent.change(section.getByLabelText("Provider"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    // Here the empty provider is a real instruction, not an absence.
    await waitFor(() =>
      expect(oc.setAiImageConfig).toHaveBeenCalledWith("ws-1", expect.objectContaining({ provider: "" })),
    );
  });

  it("checks a new image provider key before it is saved", async () => {
    oc.getAiImageConfig.mockResolvedValue(null);
    oc.setAiConfig.mockResolvedValue(storedConfig);
    oc.setAiImageConfig.mockResolvedValue({ provider: "openai", model: null, baseUrl: null, hasKey: true, capabilities: caps(true) });
    oc.testAiImageConfig.mockResolvedValue({ verified: true });
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));

    fireEvent.change(section.getByLabelText("Provider"), { target: { value: "openai" } });
    fireEvent.change(section.getByLabelText("API key"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    // A typo is cheapest to find while the person still has the real key, and
    // before it has replaced anything (#46): the unsaved values are probed
    // first, and the save follows only once they pass.
    await waitFor(() => expect(oc.setAiImageConfig).toHaveBeenCalledTimes(1));
    expect(oc.testAiImageConfig).toHaveBeenCalledWith("ws-1", expect.objectContaining({ provider: "openai", apiKey: "sk-new" }));
    expect(oc.testAiImageConfig.mock.invocationCallOrder[0]).toBeLessThan(oc.setAiImageConfig.mock.invocationCallOrder[0]);
  });

  it("refuses a provider change that arrives without the new provider's key", async () => {
    renderForm();
    await screen.findByRole("button", { name: "Replace" });
    fireEvent.change(mainField("Provider"), { target: { value: "deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(oc.setAiConfig).not.toHaveBeenCalled();
  });
});

// #46: the settings are tested as typed, before they can replace settings that
// work. A save that skipped this is how a typo in a key, a wrong host or a
// model the provider does not serve used to reach every member of the
// workspace as a failed generation.
describe("testing before saving", () => {
  const rejected = (code: string) => new ApiError(502, "/v1/workspaces/ws-1/ai-config/test", { code });

  it("tests the typed settings first, and saves only once they pass", async () => {
    oc.setAiConfig.mockResolvedValue(storedConfig);
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.change(mainField("Model (optional)"), { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(oc.setAiConfig).toHaveBeenCalledTimes(1));
    // The test carried the SAME values the save then sent.
    expect(oc.testAiConfig).toHaveBeenCalledWith("ws-1", expect.objectContaining({ provider: "openai", model: "gpt-4.1" }));
    expect(oc.testAiConfig.mock.calls[0][1]).toEqual(oc.setAiConfig.mock.calls[0][1]);
    expect(oc.testAiConfig.mock.invocationCallOrder[0]).toBeLessThan(oc.setAiConfig.mock.invocationCallOrder[0]);
  });

  it("saves nothing when the test fails, and says why", async () => {
    oc.testAiConfig.mockRejectedValue(rejected("ai_provider_model_not_found"));
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    expect(await screen.findByText(/Not saved: the connection test failed/)).toBeTruthy();
    expect(screen.getByText(/does not recognize the configured model or endpoint|doesn't recognize the configured model/)).toBeTruthy();
    expect(oc.setAiConfig).not.toHaveBeenCalled();
    expect(oc.setSearchConfig).not.toHaveBeenCalled();
    // The field the reason points at is marked, for assistive tech as well.
    expect(mainField("Model (optional)").getAttribute("aria-invalid")).toBe("true");
  });

  it("offers Save anyway, which saves without testing again", async () => {
    oc.testAiConfig.mockRejectedValue(rejected("ai_provider_unreachable"));
    oc.setAiConfig.mockResolvedValue(storedConfig);
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    const anyway = await screen.findByRole("button", { name: "Save anyway" });
    // An unreachable host points at the base URL.
    expect(mainField("Base URL").getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(anyway);

    await waitFor(() => expect(oc.setAiConfig).toHaveBeenCalledTimes(1));
    expect(oc.testAiConfig).toHaveBeenCalledTimes(1);
    // The confirmation says plainly that it went in untested.
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/without a passing connection test/));
    // And the "Not saved" verdict goes: it stopped being true when the save landed.
    await waitFor(() => expect(screen.queryByText(/Not saved: the connection test failed/)).toBeNull());
  });

  it("retires a verdict as soon as a field changes", async () => {
    oc.testAiConfig.mockRejectedValue(rejected("ai_provider_auth_failed"));
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Not saved: the connection test failed/)).toBeTruthy();

    // The verdict was about the values it tested, not these ones.
    fireEvent.change(mainField("Model (optional)"), { target: { value: "gpt-4.1" } });
    expect(screen.queryByText(/Not saved: the connection test failed/)).toBeNull();
  });

  it("can test without saving", async () => {
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText(/Connection works: OpenAI answered/)).toBeTruthy();
    expect(oc.setAiConfig).not.toHaveBeenCalled();
  });

  it("does not save when the new image provider fails its check", async () => {
    oc.testAiImageConfig.mockRejectedValue(new ApiError(502, "/x", { code: "ai_provider_auth_failed" }));
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));
    fireEvent.change(section.getByLabelText("Provider"), { target: { value: "together" } });
    fireEvent.change(section.getByLabelText("API key"), { target: { value: "sk-typo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    expect(await screen.findByText(/The image provider did not pass its check/)).toBeTruthy();
    expect(oc.setAiConfig).not.toHaveBeenCalled();
    expect(oc.setAiImageConfig).not.toHaveBeenCalled();
  });
});

describe("capability warnings", () => {
  it("lists what a text-only setup leaves out, beside the save", async () => {
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.change(mainField("Provider"), { target: { value: "deepseek" } });
    expect(screen.getByText(/Image generation: no configured provider can generate images/)).toBeTruthy();
  });

  it("asks before saving settings that lose image generation, and saves nothing on no", async () => {
    confirmAction.mockResolvedValue(false);
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    fireEvent.change(mainField("Provider"), { target: { value: "deepseek" } });
    fireEvent.change(mainField("API key"), { target: { value: "sk-deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    expect(confirmAction.mock.calls[0][0].message).toMatch(/Image generation/);
    expect(oc.testAiConfig).not.toHaveBeenCalled();
    expect(oc.setAiConfig).not.toHaveBeenCalled();
  });

  it("does not ask again about a gap the stored setup already had", async () => {
    oc.setAiConfig.mockResolvedValue(storedConfig);
    renderForm();
    await screen.findByRole("group", { name: "Image provider" });
    // The fixture's OpenAI cannot read or edit images, and never could: saving
    // it unchanged is not news, so no confirmation.
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(oc.setAiConfig).toHaveBeenCalledTimes(1));
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("clears the image warning once an image provider fills the gap", async () => {
    renderForm();
    const section = within(await screen.findByRole("group", { name: "Image provider" }));
    fireEvent.change(mainField("Provider"), { target: { value: "deepseek" } });
    fireEvent.change(section.getByLabelText("Provider"), { target: { value: "together" } });
    expect(screen.queryByText(/Image generation: no configured provider can generate images/)).toBeNull();
  });
});
