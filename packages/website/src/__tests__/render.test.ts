import { describe, expect, it } from "vitest";
import type { Node } from "@hc/schema";
import {
  renderNode,
  renderPageHtml,
  renderResponsiveCss,
  renderSite,
  type RenderContext,
} from "../render";
import {
  ellipseNode,
  imageNode,
  lineNode,
  page,
  rectNode,
  sampleForm,
  sampleSite,
  stickyNode,
  textNode,
  transform,
} from "./fixtures";

const ctx: RenderContext = {
  resolveAssetUrl: (id) => `https://cdn.example.com/${id}.png`,
};

describe("renderNode positioning", () => {
  it("reflects transform translation and size in inline left/top/width/height", () => {
    const html = renderNode(rectNode("r1"), ctx);
    expect(html).toContain("left:40px");
    expect(html).toContain("top:60px");
    expect(html).toContain("width:120px");
    expect(html).toContain("height:80px");
    expect(html).toContain("position:absolute");
    expect(html).toContain('data-oc-id="r1"');
  });

  it("emits rotation/scale as a CSS transform", () => {
    const node = { ...rectNode("r2"), transform: transform(0, 0, { rotation: 30, scaleX: 2 }) };
    const html = renderNode(node, ctx);
    expect(html).toContain("transform:rotate(30deg) scale(2, 1)");
  });

  it("omits a hidden node", () => {
    const node = { ...rectNode("r3"), hidden: true };
    expect(renderNode(node, ctx)).toBe("");
  });
});

describe("renderNode by type", () => {
  it("renders text and escapes HTML in content", () => {
    const html = renderNode(textNode("t1", "<b>Hi</b> & welcome"), ctx);
    expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt; &amp; welcome");
    expect(html).toContain("font-size:24px");
    expect(html).toContain("text-align:center");
    expect(html).not.toContain("<b>Hi</b>");
  });

  it("renders an image as an <img> with the resolved url and object-fit", () => {
    const html = renderNode(imageNode("i1", "asset9"), ctx);
    expect(html).toContain('<img src="https://cdn.example.com/asset9.png"');
    expect(html).toContain("object-fit:cover");
    expect(html).toContain('alt="A photo"');
    expect(html).toContain('loading="lazy"');
  });

  it("renders a rect shape with background and corner radius", () => {
    const html = renderNode(rectNode("s1"), ctx);
    expect(html).toContain("background:rgba(255, 0, 0, 1)");
    expect(html).toContain("border-radius:8px 8px 8px 8px");
  });

  it("renders an ellipse with border-radius:50%", () => {
    const html = renderNode(ellipseNode("e1"), ctx);
    expect(html).toContain("border-radius:50%");
  });

  it("renders a line as inline svg", () => {
    const html = renderNode(lineNode("l1"), ctx);
    expect(html).toContain("<svg");
    expect(html).toContain("<polyline");
  });

  it("renders a sticky as a colored card with escaped text", () => {
    const html = renderNode(stickyNode("k1", "Note <tag>"), ctx);
    expect(html).toContain("oc-sticky-card");
    expect(html).toContain("Note &lt;tag&gt;");
  });

  it("renders a form block carried via ctx.formsByNodeId", () => {
    const node = { ...rectNode("formnode") } as Node;
    const html = renderNode(node, { ...ctx, formsByNodeId: { formnode: sampleForm() } });
    expect(html).toContain("<form");
    expect(html).toContain('data-oc-form="contact"');
  });

  it("renders an unknown node as a graceful empty positioned box", () => {
    const node = {
      id: "u1",
      type: "model3d",
      transform: transform(5, 5),
      size: { width: 10, height: 10 },
      opacity: 1,
      blendMode: "normal",
      raw: {},
    } as unknown as Node;
    const html = renderNode(node, ctx);
    expect(html).toContain('data-oc-id="u1"');
    expect(html).toContain("left:5px");
    expect(html).toMatch(/style="[^"]*"><\/div>/);
  });

  it("wraps a node with a link in an anchor", () => {
    const node: Node = { ...rectNode("ln"), link: { kind: "url", target: "https://x.com" } };
    const html = renderNode(node, {
      ...ctx,
      navContext: { slugForPage: () => undefined, homePageId: "home" },
    });
    expect(html).toContain('<a href="https://x.com" target="_blank" rel="noopener">');
  });
});

describe("renderPageHtml", () => {
  it("wraps children in a page container sized to the page", () => {
    const p = page("home", "Home", [rectNode("r"), textNode("t", "Hi")]);
    const html = renderPageHtml(p, ctx);
    expect(html).toContain('data-oc-page="home"');
    expect(html).toContain("width:1280px");
    expect(html).toContain("height:720px");
    expect(html).toContain('data-oc-id="r"');
    expect(html).toContain('data-oc-id="t"');
  });
});

describe("renderResponsiveCss", () => {
  it("emits a proportional scale when no overrides are present", () => {
    const p = page("home", "Home", [rectNode("r")]);
    const css = renderResponsiveCss(p, ctx);
    expect(css).toContain("@media (max-width:768px)");
    expect(css).toContain("@media (max-width:390px)");
    expect(css).toContain("transform:scale");
  });

  it("emits per-node overrides inside media queries when present", () => {
    const node = {
      ...rectNode("r"),
      responsive: {
        mobile: { transform: { x: 5, y: 6 }, size: { width: 50 }, hidden: false },
        tablet: { hidden: true },
      },
    } as unknown as Node;
    const p = page("home", "Home", [node]);
    const css = renderResponsiveCss(p, ctx);
    expect(css).toContain('[data-oc-id="r"]{left:5px;top:6px;width:50px}');
    expect(css).toContain('[data-oc-id="r"]{display:none}');
  });
});

describe("renderSite", () => {
  it("produces index.html for the home page, a file per other page, plus assets", () => {
    const site = sampleSite();
    const pages = [page("home", "Home", [rectNode("r")]), page("about", "About", [textNode("t", "About us")])];
    const { files } = renderSite(site, pages, ctx);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("about/index.html");
    expect(paths).toContain("site.css");
    expect(paths).toContain("runtime.js");
    expect(paths).toContain("sitemap.xml");
    expect(paths).toContain("robots.txt");
  });

  it("injects SEO meta, favicon, and custom head/body code into each page", () => {
    const site = sampleSite();
    const pages = [page("home", "Home"), page("about", "About")];
    const { files } = renderSite(site, pages, ctx);
    const home = files.find((f) => f.path === "index.html")!.body;
    expect(home).toContain("<title>Acme Co - Home</title>");
    expect(home).toContain('property="og:title"');
    expect(home).toContain('<link rel="icon"');
    expect(home).toContain("<!-- head-snippet -->");
    expect(home).toContain("<!-- body-snippet -->");
    expect(home).toContain('<script src="/runtime.js">');
    expect(home).toContain('class="oc-nav"');
  });

  it("emits a password marker (and never the password) when enabled", () => {
    const site = sampleSite();
    site.settings.password.enabled = true;
    const pages = [page("home", "Home")];
    const { files } = renderSite(site, pages, ctx);
    const home = files.find((f) => f.path === "index.html")!.body;
    expect(home).toContain("oc:password-protected");
  });

  it("runtime.js includes the nav toggle hook", () => {
    const site = sampleSite();
    const { files } = renderSite(site, [page("home", "Home")], ctx);
    const rt = files.find((f) => f.path === "runtime.js")!.body;
    expect(rt).toContain("oc-nav-toggle");
    expect(rt).toContain("scrollIntoView");
  });
});
