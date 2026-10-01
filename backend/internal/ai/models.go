// The provider's model catalog, for the settings form.
//
// A model name typed from memory is the most common way a configuration goes
// wrong: the connection test passes on the key and fails on the model, or the
// save lands a name the provider retired last month. Every provider in the
// catalog but one can list what it serves, so the form fetches that list once
// the connection details are in and offers it in the model field, with free
// text still allowed for a name the catalog does not carry.
//
// Listing is free on every provider (no tokens, no metering) and reads the
// same host and credential a call would use, so a wrong key is caught here
// too. Azure lists deployments rather than models, Bedrock lists on its
// control plane rather than the runtime host, Anthropic has its own route, and
// everything else speaks the OpenAI-compatible GET /models.
package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ModelInfo is one model a provider lists.
type ModelInfo struct {
	ID string `json:"id"`
	// Label is the provider's display name for it, when it gives one.
	Label string `json:"label,omitempty"`
}

// ModelList is the answer to a listing request.
type ModelList struct {
	Models []ModelInfo `json:"models"`
	// Supported is false when the provider has no catalog this transport can
	// read (an endpoint without a models route, an Azure resource that does
	// not answer the deployments call). The model field then stays free text
	// and the form says why the list is empty.
	Supported bool `json:"supported"`
}

// Purposes narrow a catalog to the models a field can use.
const (
	PurposeText  = "text"
	PurposeImage = "image"
)

// maxListedModels bounds the answer; a catalog past it is unusable in a field
// anyway.
const maxListedModels = 500

// ListModels lists the models a CANDIDATE main config can reach, without
// saving it: the typed key and host when given, the stored ones otherwise, as
// on a connection test. purpose is PurposeText, PurposeImage or "" for every
// model the provider lists.
func (s *Service) ListModels(ctx context.Context, workspaceID string, in ConfigInput, purpose string) (ModelList, error) {
	rc, err := s.resolveConfig(ctx, workspaceID, in)
	if err != nil {
		return ModelList{}, err
	}
	cfg, err := s.candidateCallConfig(rc)
	if err != nil {
		return ModelList{}, err
	}
	return s.listModels(ctx, cfg, purpose)
}

// ListStoredModels lists the models the workspace's saved main provider can
// reach.
func (s *Service) ListStoredModels(ctx context.Context, workspaceID, purpose string) (ModelList, error) {
	cfg, err := s.callConfig(ctx, workspaceID)
	if err != nil {
		return ModelList{}, err
	}
	return s.listModels(ctx, cfg, purpose)
}

// ListImageModels lists the image models a CANDIDATE dedicated image provider
// can reach, without saving it.
func (s *Service) ListImageModels(ctx context.Context, workspaceID string, in ImageConfigInput) (ModelList, error) {
	if in.Provider == "" {
		return ModelList{}, ErrBadRequest
	}
	rc, err := s.resolveImageConfig(ctx, workspaceID, in)
	if err != nil {
		return ModelList{}, err
	}
	cfg, err := s.imageCandidateCallConfig(rc)
	if err != nil {
		return ModelList{}, err
	}
	return s.listModels(ctx, cfg, PurposeImage)
}

// listModels dispatches on the provider's catalog route.
func (s *Service) listModels(ctx context.Context, cfg CallConfig, purpose string) (ModelList, error) {
	switch cfg.Provider {
	case ProviderAnthropic:
		return s.listAnthropicModels(ctx, cfg, purpose)
	case ProviderBedrock:
		return s.listBedrockModels(ctx, cfg, purpose)
	case ProviderAzureOpenAI:
		return s.listAzureDeployments(ctx, cfg, purpose)
	default:
		return s.listOpenAICompatModels(ctx, cfg, purpose)
	}
}

// getJSON performs one authenticated GET against a provider and returns the
// body; sign, when given, adds the credential to the request.
func (s *Service) getJSON(ctx context.Context, rawURL string, headers map[string]string, sign func(*http.Request)) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, ErrBadRequest
	}
	req.Header.Set("accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if sign != nil {
		sign(req)
	}
	return s.do(req, providerTimeout)
}

// noCatalog turns a listing failure into either "this provider has no
// catalog here" (a route that does not exist: 400, 404, 405) or the
// classified provider error a call would raise (a rejected key, a rate
// limit, an unreachable host).
func noCatalog(cfg CallConfig, err error) (ModelList, error) {
	var se *httpStatusError
	if errors.As(err, &se) {
		switch se.status {
		case http.StatusBadRequest, http.StatusNotFound, http.StatusMethodNotAllowed:
			return ModelList{Models: []ModelInfo{}}, nil
		}
	}
	return ModelList{}, badGateway(cfg, err)
}

// --- OpenAI-compatible -------------------------------------------------------

// catalogEntry is the union of the fields the OpenAI-compatible dialects and
// Anthropic put on a listed model.
type catalogEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	// Azure's deployments call: the deployment is the id, this is its model.
	Model string `json:"model"`
}

// parseCatalog reads a model list in either of the shapes in circulation: an
// object with a data array (OpenAI, Anthropic, Azure, most compatibles) or a
// bare array (Together). Returns false when neither fits.
func parseCatalog(raw []byte) ([]catalogEntry, bool) {
	var wrapped struct {
		Data []catalogEntry `json:"data"`
	}
	if err := json.Unmarshal(raw, &wrapped); err == nil && wrapped.Data != nil {
		return wrapped.Data, true
	}
	var bare []catalogEntry
	if err := json.Unmarshal(raw, &bare); err == nil {
		return bare, true
	}
	return nil, false
}

func (s *Service) listOpenAICompatModels(ctx context.Context, cfg CallConfig, purpose string) (ModelList, error) {
	base := strings.TrimRight(orDefault(cfg.BaseURL, "https://api.openai.com/v1"), "/")
	raw, err := s.getJSON(ctx, base+"/models", map[string]string{"authorization": "Bearer " + cfg.APIKey}, nil)
	if err != nil {
		return noCatalog(cfg, err)
	}
	entries, ok := parseCatalog(raw)
	if !ok {
		return ModelList{Models: []ModelInfo{}}, nil
	}
	models := make([]ModelInfo, 0, len(entries))
	for _, e := range entries {
		id := strings.TrimSpace(e.ID)
		// Google's compatibility layer lists "models/gemini-...", and takes
		// the bare name on a call; offer the name the call wants.
		if cfg.Provider == "google" {
			id = strings.TrimPrefix(id, "models/")
		}
		if id == "" {
			continue
		}
		models = append(models, ModelInfo{ID: id, Label: firstNonEmptyString(e.DisplayName, e.Name)})
	}
	return finishCatalog(models, purpose), nil
}

// --- Anthropic ----------------------------------------------------------------

func (s *Service) listAnthropicModels(ctx context.Context, cfg CallConfig, purpose string) (ModelList, error) {
	base := strings.TrimRight(orDefault(cfg.BaseURL, "https://api.anthropic.com"), "/")
	raw, err := s.getJSON(ctx, base+"/v1/models?limit=1000", map[string]string{"x-api-key": cfg.APIKey, "anthropic-version": "2023-06-01"}, nil)
	if err != nil {
		return noCatalog(cfg, err)
	}
	entries, ok := parseCatalog(raw)
	if !ok {
		return ModelList{Models: []ModelInfo{}}, nil
	}
	models := make([]ModelInfo, 0, len(entries))
	for _, e := range entries {
		if id := strings.TrimSpace(e.ID); id != "" {
			models = append(models, ModelInfo{ID: id, Label: e.DisplayName})
		}
	}
	// Anthropic serves text models only; an image field has nothing to pick.
	if purpose == PurposeImage {
		models = nil
	}
	return finishCatalog(models, ""), nil
}

// --- Azure OpenAI -------------------------------------------------------------

// listAzureDeployments lists the resource's DEPLOYMENTS, which is what the
// model field names on Azure (the transport routes by deployment). The
// deployments route predates the GA data-plane version this transport pins,
// so it is asked for with its own api-version; a resource that no longer
// answers it reports no catalog rather than an error.
func (s *Service) listAzureDeployments(ctx context.Context, cfg CallConfig, purpose string) (ModelList, error) {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		return ModelList{}, ErrBaseURLRequired
	}
	raw, err := s.getJSON(ctx, base+"/openai/deployments?api-version=2023-03-15-preview", map[string]string{"api-key": cfg.APIKey}, nil)
	if err != nil {
		return noCatalog(cfg, err)
	}
	entries, ok := parseCatalog(raw)
	if !ok {
		return ModelList{Models: []ModelInfo{}}, nil
	}
	models := make([]ModelInfo, 0, len(entries))
	for _, e := range entries {
		if id := strings.TrimSpace(e.ID); id != "" {
			models = append(models, ModelInfo{ID: id, Label: e.Model})
		}
	}
	// The purpose filter reads the underlying model, not the deployment's
	// name, which is whatever the admin called it.
	if purpose != "" {
		kept := models[:0]
		for _, m := range models {
			if purposeAdmits(purpose, firstNonEmptyString(m.Label, m.ID)) {
				kept = append(kept, m)
			}
		}
		models = kept
	}
	return finishCatalog(models, ""), nil
}

// --- Amazon Bedrock -----------------------------------------------------------

// bedrockControlPlaneURL turns the runtime endpoint a workspace configures
// (bedrock-runtime.<region>.amazonaws.com) into the control plane host that
// serves the catalog (bedrock.<region>.amazonaws.com). A VPC endpoint or a
// host that is not shaped like one is returned unchanged.
func bedrockControlPlaneURL(baseURL string) string {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || u.Host == "" {
		return ""
	}
	host := u.Hostname()
	if strings.HasPrefix(strings.ToLower(host), "bedrock-runtime.") {
		host = "bedrock." + host[len("bedrock-runtime."):]
	}
	if port := u.Port(); port != "" {
		host += ":" + port
	}
	return u.Scheme + "://" + host
}

// bedrockSummary is one foundation model as ListFoundationModels reports it.
type bedrockSummary struct {
	ModelID                 string   `json:"modelId"`
	ModelName               string   `json:"modelName"`
	ProviderName            string   `json:"providerName"`
	OutputModalities        []string `json:"outputModalities"`
	InferenceTypesSupported []string `json:"inferenceTypesSupported"`
	ModelLifecycle          struct {
		Status string `json:"status"`
	} `json:"modelLifecycle"`
}

// bedrockProfile is one inference profile as ListInferenceProfiles reports
// it. Profiles are how the current models are reached (the "us." prefixed
// ids route across regions), so a text field lists them beside the models.
type bedrockProfile struct {
	InferenceProfileID   string `json:"inferenceProfileId"`
	InferenceProfileName string `json:"inferenceProfileName"`
	Status               string `json:"status"`
}

// parseBedrockModels reads a ListFoundationModels answer into models that
// serve the purpose: on-demand, active, with the modality the field wants.
func parseBedrockModels(raw []byte, purpose string) []ModelInfo {
	var body struct {
		ModelSummaries []bedrockSummary `json:"modelSummaries"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	var out []ModelInfo
	for _, m := range body.ModelSummaries {
		if m.ModelID == "" || (m.ModelLifecycle.Status != "" && m.ModelLifecycle.Status != "ACTIVE") {
			continue
		}
		if len(m.InferenceTypesSupported) > 0 && !containsFold(m.InferenceTypesSupported, "ON_DEMAND") {
			continue
		}
		switch purpose {
		case PurposeText:
			if !containsFold(m.OutputModalities, "TEXT") {
				continue
			}
		case PurposeImage:
			if !containsFold(m.OutputModalities, "IMAGE") {
				continue
			}
		}
		label := m.ModelName
		if m.ProviderName != "" && label != "" {
			label = m.ProviderName + " " + label
		}
		out = append(out, ModelInfo{ID: m.ModelID, Label: label})
	}
	return out
}

// parseBedrockProfiles reads a ListInferenceProfiles answer into models.
func parseBedrockProfiles(raw []byte) []ModelInfo {
	var body struct {
		InferenceProfileSummaries []bedrockProfile `json:"inferenceProfileSummaries"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	var out []ModelInfo
	for _, p := range body.InferenceProfileSummaries {
		if p.InferenceProfileID == "" || (p.Status != "" && p.Status != "ACTIVE") {
			continue
		}
		out = append(out, ModelInfo{ID: p.InferenceProfileID, Label: p.InferenceProfileName})
	}
	return out
}

func (s *Service) listBedrockModels(ctx context.Context, cfg CallConfig, purpose string) (ModelList, error) {
	control := bedrockControlPlaneURL(cfg.BaseURL)
	region := bedrockRegionFrom(cfg.BaseURL)
	if control == "" || region == "" {
		return ModelList{}, ErrBaseURLRequired
	}
	creds := awsCreds{AccessKeyID: cfg.APIKey, SecretKey: cfg.APISecret, Region: region, Service: "bedrock"}
	sign := func(req *http.Request) { signAWSv4(req, nil, creds, time.Now()) }

	// The query is written in canonical order (sorted names), because the
	// signature covers it byte for byte.
	query := "byInferenceType=ON_DEMAND"
	switch purpose {
	case PurposeText:
		query += "&byOutputModality=TEXT"
	case PurposeImage:
		query += "&byOutputModality=IMAGE"
	}
	raw, err := s.getJSON(ctx, control+"/foundation-models?"+query, nil, sign)
	if err != nil {
		// A credential scoped to InvokeModel alone is refused the catalog
		// with 403 and is still a working credential, so a Bedrock refusal
		// is "no catalog" rather than a rejected key; the connection test is
		// the authority on the key.
		var se *httpStatusError
		if errors.As(err, &se) && se.status == http.StatusForbidden {
			return ModelList{Models: []ModelInfo{}}, nil
		}
		return noCatalog(cfg, err)
	}
	models := parseBedrockModels(raw, purpose)

	// Inference profiles are how the current models are reached, image
	// models included (an account may see Stability's image profiles and no
	// on-demand image model at all). A profile carries no modality, so the
	// image field takes the profiles named like image models and the text
	// field the rest; a failure to list them leaves the models already found.
	if raw, err := s.getJSON(ctx, control+"/inference-profiles?maxResults=1000&typeEquals=SYSTEM_DEFINED", nil, sign); err == nil {
		for _, p := range parseBedrockProfiles(raw) {
			if purpose == PurposeImage && !imageModelRe.MatchString(p.ID) {
				continue
			}
			models = append(models, p)
		}
	}
	// The modality has done the image filtering; the text field still drops
	// what the TEXT modality admits but a chat field cannot use (rerankers,
	// speech and video models, the image profiles).
	byName := ""
	if purpose == PurposeText {
		byName = PurposeText
	}
	return finishCatalog(models, byName), nil
}

// --- shaping ------------------------------------------------------------------

var (
	// imageModelRe names the image models in the OpenAI-compatible catalogs,
	// which list every model a key can reach with no modality to filter on.
	imageModelRe = regexp.MustCompile(`(?i)(dall-e|gpt-image|image|flux|cogview|stable-diffusion|sdxl|imagen|canvas|kolors|seedream|photon|recraft|ideogram)`)
	// notTextModelRe names what a chat field has no use for.
	notTextModelRe = regexp.MustCompile(`(?i)(embed|whisper|tts|moderation|dall-e|gpt-image|transcribe|-audio|realtime|sora|rerank|guard|sonic|speech|stability|stable-|canvas|titan-image|nova-reel|upscale|twelvelabs|marengo|pegasus)`)
)

// purposeAdmits reports whether a model name may serve a purpose, on the name
// alone: the text field drops what plainly is not a chat model, the image
// field keeps what plainly is an image model. An empty purpose admits all.
func purposeAdmits(purpose, name string) bool {
	switch purpose {
	case PurposeText:
		return !notTextModelRe.MatchString(name)
	case PurposeImage:
		return imageModelRe.MatchString(name)
	}
	return true
}

// finishCatalog applies the purpose to a catalog that carries no modality of
// its own, then dedupes, sorts and bounds it. An image purpose that matches
// nothing by name returns the whole catalog rather than an empty field: the
// heuristic is a convenience, not a gate.
func finishCatalog(models []ModelInfo, purpose string) ModelList {
	if purpose != "" {
		kept := make([]ModelInfo, 0, len(models))
		for _, m := range models {
			if purposeAdmits(purpose, m.ID) {
				kept = append(kept, m)
			}
		}
		if purpose == PurposeText || len(kept) > 0 {
			models = kept
		}
	}
	seen := map[string]bool{}
	out := make([]ModelInfo, 0, len(models))
	for _, m := range models {
		if seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	if len(out) > maxListedModels {
		out = out[:maxListedModels]
	}
	return ModelList{Models: out, Supported: true}
}

func containsFold(xs []string, v string) bool {
	for _, x := range xs {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}
