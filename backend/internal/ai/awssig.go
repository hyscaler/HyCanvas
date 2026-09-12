// AWS Signature Version 4 request signing, for the Amazon Bedrock provider.
//
// Every other provider in the catalog authenticates with a static header: a
// bearer token, an api-key, an x-api-key. Bedrock does not. Each request is
// signed with a key derived from the secret access key, the date, the region
// and the service, over a canonical form of the request itself, so the
// signature covers the method, path, query, a chosen set of headers, and a
// hash of the body.
//
// Implemented here rather than pulled in: the AWS SDK is a large dependency to
// add for one provider's auth, and this is the whole of what the Bedrock
// runtime needs. It is the standard algorithm, no service-specific quirks.

package ai

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// awsCreds is what a signed request needs beyond the request itself. Region is
// parsed from the endpoint host, so a workspace configures one base URL rather
// than a URL and a region that can disagree.
type awsCreds struct {
	AccessKeyID string
	SecretKey   string
	Region      string
	Service     string
}

// bedrockRegionFrom reads the region out of a Bedrock runtime endpoint:
// https://bedrock-runtime.us-east-1.amazonaws.com -> "us-east-1".
//
// Deriving it beats storing it separately, which would let the host and the
// region drift apart and produce a signature mismatch that reads as "your key
// is wrong". Returns "" when the host is not shaped like an AWS regional
// endpoint, and the caller treats that as a misconfiguration.
func bedrockRegionFrom(baseURL string) string {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || u.Host == "" {
		return ""
	}
	parts := strings.Split(strings.ToLower(u.Hostname()), ".")
	// bedrock-runtime.<region>.amazonaws.com, or a VPC endpoint carrying the
	// same two leading labels.
	for i, p := range parts {
		if (p == "bedrock-runtime" || p == "bedrock") && i+1 < len(parts) {
			if r := parts[i+1]; r != "" && r != "amazonaws" {
				return r
			}
		}
	}
	return ""
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// signAWSv4 signs req in place for the given credentials and body.
//
// The signed header set is deliberately minimal (host, x-amz-date, and
// content-type when present): every header included must be reproduced byte for
// byte by the service, and a proxy that rewrites an incidental header would
// otherwise break the signature.
func signAWSv4(req *http.Request, body []byte, c awsCreds, now time.Time) {
	now = now.UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	payloadHash := sha256Hex(body)

	req.Header.Set("x-amz-date", amzDate)
	if req.Host == "" {
		req.Host = req.URL.Host
	}

	// Canonical headers, lowercase names, sorted, values trimmed.
	//
	// x-amz-content-sha256 is deliberately NOT sent: it is mandatory for S3 and
	// optional elsewhere, the payload hash is already covered by the canonical
	// request, and leaving it out keeps this signer byte-identical to AWS's
	// published signing examples, which is what the test pins it against.
	signed := []string{"host", "x-amz-date"}
	values := map[string]string{
		"host":       req.URL.Host,
		"x-amz-date": amzDate,
	}
	if ct := req.Header.Get("content-type"); ct != "" {
		signed = append(signed, "content-type")
		values["content-type"] = ct
	}
	sort.Strings(signed)
	var canonicalHeaders strings.Builder
	for _, h := range signed {
		canonicalHeaders.WriteString(h)
		canonicalHeaders.WriteString(":")
		canonicalHeaders.WriteString(strings.TrimSpace(values[h]))
		canonicalHeaders.WriteString("\n")
	}
	signedHeaders := strings.Join(signed, ";")

	canonicalURI := req.URL.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}
	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalURI,
		req.URL.RawQuery,
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")

	scope := strings.Join([]string{dateStamp, c.Region, c.Service, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	key := hmacSHA256([]byte("AWS4"+c.SecretKey), dateStamp)
	key = hmacSHA256(key, c.Region)
	key = hmacSHA256(key, c.Service)
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))

	req.Header.Set("authorization", "AWS4-HMAC-SHA256 Credential="+c.AccessKeyID+"/"+scope+
		", SignedHeaders="+signedHeaders+", Signature="+signature)
}
