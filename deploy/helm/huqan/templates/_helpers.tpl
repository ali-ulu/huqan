{{/*
Expand the name of the chart.
*/}}
{{- define "huqan.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fullname, release-scoped.
*/}}
{{- define "huqan.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "huqan.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "huqan.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: huqan
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "huqan.selectorLabels" -}}
app.kubernetes.io/name: {{ include "huqan.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the Secret carrying HUQAN_API_KEY / HUQAN_MCP_OPERATOR_TOKEN:
the release chart's own secret, or the operator-provided existingSecret.
*/}}
{{- define "huqan.secretName" -}}
{{- default (include "huqan.fullname" .) .Values.auth.existingSecret }}
{{- end }}

{{/*
Name of the PVC claim used for /app/data.
*/}}
{{- define "huqan.claimName" -}}
{{- default (printf "%s-data" (include "huqan.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}
