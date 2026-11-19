import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MockController } from "../../ui/fixtures/mock-controller.ts";
import { ChatModel } from "../../ui/model/chat-model.ts";
import { ConfigModel } from "../../ui/model/config-model.ts";
import { GraphModel } from "../../ui/model/graph-model.ts";
import { parseEvent, type UiEvent } from "../../ui/model/protocol.ts";

/** The views over the mock controller, as the preview wires them. */
const rig = () => {
  const events: UiEvent[] = [];
  const graph: InstanceType<typeof GraphModel> = new GraphModel((i) => controller.handle(i));
  const chat: InstanceType<typeof ChatModel> = new ChatModel((i) => controller.handle(i));
  const config: InstanceType<typeof ConfigModel> = new ConfigModel((i) => controller.handle(i));
  const controller: MockController = new MockController({
    emit: (e) => {
      events.push(e);
      graph.apply(e);
      chat.apply(e);
      config.apply(e);
    },
    sleep: async () => {},
  });
  controller.handle({ type: "ready", view: "graph" });
  controller.handle({ type: "ready", view: "chat" });
  return { events, graph, chat, config, controller };
};

describe("starting a conversation in a workspace folder", () => {
  test("a folder that can be initialized is offered, and one that cannot be is only listed", () => {
    const { graph } = rig();
    assert.deepEqual(
      graph.initializable.value.map((r) => [r.name, r.init]),
      [
        ["legacy-api", "adopt"],
        ["scratch", "new"],
      ],
    );
    graph.selectRepo("scratch");
    assert.equal(graph.repos.value?.current, "retry-client", "it is not a conversation yet, so it cannot be opened");
  });

  test("a new folder is initialized at once; the graph, the chat and the Providers page follow", () => {
    const { graph, chat, config, events, controller } = rig();
    events.length = 0;
    graph.initRepo("scratch");
    assert.equal(graph.initializing.value, undefined, "nothing to confirm");
    assert.equal(graph.repos.value?.current, "scratch");
    assert.equal(graph.repos.value?.repos.find((r) => r.id === "scratch")?.chattree, true);
    assert.equal(
      graph.initializable.value.some((r) => r.id === "scratch"),
      false,
    );
    assert.equal(graph.data.value?.commits.length, 1, "just the header");
    assert.equal(graph.data.value?.trunk, "main");
    assert.equal(chat.thread.value?.name, "main");
    assert.equal(config.open.value, true);
    assert.equal(config.page.value, "providers");
    assert.deepEqual(
      Object.keys((config.form.value?.spec.value.value["providers"] as object | undefined) ?? { x: 1 }),
      [],
      "no provider yet",
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ["graph.repos", "graph.data", "graph.selected", "chat.open", "form.set", "settings.open", "form.set", "instructions.set", "notice"],
    );
    for (const e of events) assert.equal(parseEvent(e).ok, true, e.type);
    void controller;
  });

  test("a folder that is already a git repository asks first, and says the conversation shares its branch", () => {
    const { graph, events } = rig();
    graph.initRepo("legacy-api");
    assert.equal(graph.initializing.value, "legacy-api");
    assert.match(graph.initConfirmation.value?.lines.join(" ") ?? "", /branch that is checked out/);
    graph.cancelInit();
    assert.equal(graph.repos.value?.current, "retry-client");
    graph.initRepo("legacy-api");
    events.length = 0;
    graph.confirmInit();
    assert.equal(graph.repos.value?.current, "legacy-api");
    assert.equal(graph.data.value?.trunk, "master", "on the branch that was there");
  });

  test("a folder that cannot be initialized, or is already a conversation, sends nothing", () => {
    const { graph, controller } = rig();
    let sent = 0;
    const handle = controller.handle.bind(controller);
    controller.handle = (i) => (sent++, handle(i));
    graph.initRepo("retry-client");
    graph.initRepo("vendor-lib");
    graph.initRepo("nope");
    assert.equal(sent, 0);
  });

  test("the picker's other entries come back after an init, and the old conversation is kept", () => {
    const { graph, controller } = rig();
    graph.initRepo("scratch");
    graph.selectRepo("retry-client");
    assert.equal(graph.repos.value?.current, "retry-client");
    assert.ok((graph.data.value?.commits.length ?? 0) > 5, "its history is as it was");
    void controller;
  });
});

describe("what keeps a thread from taking a message", () => {
  const providerForm = (config: InstanceType<typeof ConfigModel>): void => {
    const f = config.form.value;
    assert.ok(f);
    f.set(["providers", "anthropic"], { $tag: "anthropic", api_key_env: "ANTHROPIC_API_KEY" });
  };

  test("a conversation just started has no provider: sending is off until the file names one", () => {
    const { graph, chat, config, events } = rig();
    graph.initRepo("scratch");
    assert.deepEqual(chat.banner.value, { kind: "no_provider" });
    assert.equal(chat.status.value?.model, "No model yet");
    chat.setDraft("hello");
    assert.equal(chat.canSend.value, false);
    chat.send();
    assert.equal(
      chat.blocks.value.some((b) => b.type === "user"),
      false,
      "nothing was sent",
    );
    providerForm(config);
    config.save();
    assert.equal(chat.banner.value, undefined);
    assert.equal(chat.canSend.value, true);
    assert.notEqual(chat.status.value?.model, "No model yet");
    for (const e of events) assert.equal(parseEvent(e).ok, true, e.type);
  });

  test("the controller refuses a message too, as the view may be out of date", () => {
    const { graph, controller, events } = rig();
    graph.initRepo("scratch");
    events.length = 0;
    controller.handle({ type: "chat.send", text: "hello" });
    assert.deepEqual(
      events.map((e) => e.type),
      ["notice"],
    );
  });

  test("a thread whose harness.yml was changed shows the banner until it is trusted", () => {
    const { graph, chat, controller } = rig();
    graph.open(graph.data.value?.threads.find((t) => t.name === "old-attempt")?.tip ?? "");
    assert.deepEqual(chat.banner.value, { kind: "untrusted", state: "changed" });
    assert.equal(chat.canSend.value, false);
    chat.trust();
    assert.equal(chat.banner.value, undefined);
    controller.handle({ type: "thread.open", thread: "main" });
    controller.handle({ type: "thread.open", thread: "old-attempt" });
    assert.equal(chat.banner.value, undefined, "the approval is kept");
  });

  test("an unusual change shows its banner: keeping it removes it, and going back rewinds to before it", () => {
    const { graph, chat } = rig();
    const tip = () => graph.data.value?.threads.find((t) => t.name === "bench-run")?.tip ?? "";
    graph.open(tip());
    const b = chat.banner.value;
    assert.ok(b?.kind === "unusual_change");
    assert.equal(chat.canSend.value, false);
    chat.undoChange();
    assert.equal(chat.banner.value, undefined, "back before the change");
    assert.equal(tip(), b.before);
    chat.accept(); // nothing to keep any longer: asks for nothing
    graph.open(tip());
    assert.equal(chat.banner.value, undefined);
  });

  test("keeping an unusual change takes the banner away", () => {
    const { graph, chat } = rig();
    graph.open(graph.data.value?.threads.find((t) => t.name === "bench-run")?.tip ?? "");
    assert.ok(chat.banner.value?.kind === "unusual_change");
    chat.accept();
    assert.equal(chat.banner.value, undefined);
  });

  test("trusting asks for nothing when there is no banner", () => {
    const { chat, controller } = rig();
    let sent = 0;
    const handle = controller.handle.bind(controller);
    controller.handle = (i) => (sent++, handle(i));
    chat.trust();
    assert.equal(sent, 0);
  });

  test("the banners' way into the settings opens the sheet on the page", () => {
    const { config } = rig();
    config.show("providers");
    assert.equal(config.open.value, true);
    assert.equal(config.page.value, "providers");
    config.show("limits");
    assert.equal(config.page.value, "limits");
    assert.equal(config.open.value, true, "show does not toggle");
  });
});
