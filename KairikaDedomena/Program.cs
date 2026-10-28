using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddMemoryCache();
builder.Services.AddHttpClient("openmeteo", c =>
{
    c.BaseAddress = new Uri("https://archive-api.open-meteo.com/");
    c.Timeout = TimeSpan.FromSeconds(60);
});

builder.Services.AddHttpClient("openmeteo-forecast", c =>
{
    c.BaseAddress = new Uri("https://api.open-meteo.com/");
    c.Timeout = TimeSpan.FromSeconds(60);
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

// Server-side proxy for the Open-Meteo historical archive: validates the query and caches responses,
// so the browser never talks to the upstream API directly.
app.MapGet("/api/archive", async (HttpContext ctx, IHttpClientFactory http, IMemoryCache cache, CancellationToken ct) =>
{
    var q = ctx.Request.Query;
    if (!double.TryParse(q["latitude"], NumberStyles.Float, CultureInfo.InvariantCulture, out var lat) || lat is < -90 or > 90 ||
        !double.TryParse(q["longitude"], NumberStyles.Float, CultureInfo.InvariantCulture, out var lon) || lon is < -180 or > 180)
        return Results.BadRequest(new { error = true, reason = "Invalid coordinates." });

    if (!DateOnly.TryParseExact(q["start_date"], "yyyy-MM-dd", out var start) ||
        !DateOnly.TryParseExact(q["end_date"], "yyyy-MM-dd", out var end) || start > end)
        return Results.BadRequest(new { error = true, reason = "Invalid date range." });

    string daily = q["daily"].ToString(), models = q["models"].ToString();
    if (!Regex.IsMatch(daily, "^[a-z0-9_,]{1,500}$") || (models.Length > 0 && !Regex.IsMatch(models, "^[a-z0-9_,]{1,100}$")))
        return Results.BadRequest(new { error = true, reason = "Invalid variable or model list." });

    var url = FormattableString.Invariant(
        $"v1/archive?latitude={lat:0.####}&longitude={lon:0.####}&start_date={start:yyyy-MM-dd}&end_date={end:yyyy-MM-dd}&daily={daily}&timezone=Europe%2FAthens")
        + (models.Length > 0 ? $"&models={models}" : "");

    var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeBySystemTimeZoneId(DateTime.UtcNow, "Europe/Athens"));
    // The ERA5 archive lags a few days behind; ranges that reach the present are completed from the forecast API
    bool reachesPresent = end >= today.AddDays(-7);

    if (!cache.TryGetValue(url, out string? body))
    {
        using var resp = await http.CreateClient("openmeteo").GetAsync(url, ct);
        body = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
            return Results.Content(body, "application/json", statusCode: (int)resp.StatusCode);

        if (reachesPresent && models.Length == 0)
            body = await FillRecentDays(body, lat, lon, daily, end < today ? end : today, http, ct);

        cache.Set(url, body, new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = reachesPresent ? TimeSpan.FromMinutes(30) : TimeSpan.FromHours(6) });
    }
    return Results.Content(body!, "application/json");
});

app.Run();

// Appends the days after the archive's last complete day (up to `through`) from the forecast API's recent past.
static async Task<string> FillRecentDays(string archiveBody, double lat, double lon, string daily, DateOnly through, IHttpClientFactory http, CancellationToken ct)
{
    try
    {
        var root = JsonNode.Parse(archiveBody)!;
        var d = root["daily"]!.AsObject();
        var times = d["time"]!.AsArray();
        int n = times.Count;
        while (n > 0 && d["temperature_2m_max"]![n - 1] is null) n--;
        if (n == 0) return archiveBody;
        var from = DateOnly.ParseExact(times[n - 1]!.GetValue<string>(), "yyyy-MM-dd").AddDays(1);
        if (from > through || from < through.AddDays(-80)) return archiveBody;

        var url = FormattableString.Invariant(
            $"v1/forecast?latitude={lat:0.####}&longitude={lon:0.####}&start_date={from:yyyy-MM-dd}&end_date={through:yyyy-MM-dd}&daily={daily}&timezone=Europe%2FAthens");
        using var resp = await http.CreateClient("openmeteo-forecast").GetAsync(url, ct);
        if (!resp.IsSuccessStatusCode) return archiveBody;
        var extra = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct))!["daily"]!.AsObject();

        foreach (var key in d.Select(kv => kv.Key).ToList())
        {
            var target = d[key]!.AsArray();
            while (target.Count > n) target.RemoveAt(target.Count - 1);
            var source = extra[key]?.AsArray();
            for (int i = 0; i < extra["time"]!.AsArray().Count; i++)
                target.Add(source?[i]?.DeepClone());
        }
        root["filled_from"] = from.ToString("yyyy-MM-dd");
        return root.ToJsonString();
    }
    catch (Exception ex) when (ex is System.Text.Json.JsonException or HttpRequestException or TaskCanceledException or InvalidOperationException)
    {
        return archiveBody;
    }
}
