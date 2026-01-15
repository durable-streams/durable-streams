namespace DurableStreams;

/// <summary>
/// Opaque stream offset token.
///
/// Per protocol specification (Section 6):
/// - Offsets are OPAQUE: do not parse or construct arbitrary offset values
/// - Offsets are LEXICOGRAPHICALLY SORTABLE: comparison operators are valid
///   and reflect stream position ordering
/// - Only use offsets received from the server (Stream-Next-Offset header,
///   control events) or the sentinel values (Beginning, Now)
/// </summary>
public readonly struct Offset : IEquatable<Offset>, IComparable<Offset>
{
    /// <summary>
    /// Beginning of stream (offset -1).
    /// </summary>
    public static readonly Offset Beginning = new("-1");

    /// <summary>
    /// Current tail position (skip historical data).
    /// </summary>
    public static readonly Offset Now = new("now");

    private readonly string _value;

    /// <summary>
    /// Create an offset from a string value.
    /// </summary>
    public Offset(string value)
    {
        _value = value ?? throw new ArgumentNullException(nameof(value));
    }

    /// <summary>
    /// Returns the raw offset string.
    /// </summary>
    public override string ToString() => _value;

    /// <summary>
    /// Returns true if this is the Beginning offset (-1).
    /// </summary>
    public bool IsBeginning => _value == "-1";

    /// <summary>
    /// Returns true if this is the Now offset.
    /// </summary>
    public bool IsNow => _value == "now";

    /// <summary>
    /// Returns true if this offset has a valid value.
    /// </summary>
    public bool HasValue => !string.IsNullOrEmpty(_value);

    /// <summary>
    /// Implicit conversion from string.
    /// </summary>
    public static implicit operator string(Offset offset) => offset._value;

    /// <summary>
    /// Explicit conversion from string to Offset.
    /// Use this for server-provided offset values. For sentinel values, prefer Offset.Beginning or Offset.Now.
    /// </summary>
    public static explicit operator Offset(string value) => new(value);

    /// <summary>
    /// Lexicographic comparison (per protocol specification).
    /// </summary>
    public int CompareTo(Offset other) =>
        string.Compare(_value, other._value, StringComparison.Ordinal);

    /// <inheritdoc />
    public bool Equals(Offset other) => _value == other._value;

    /// <inheritdoc />
    public override bool Equals(object? obj) => obj is Offset o && Equals(o);

    /// <inheritdoc />
    public override int GetHashCode() => _value?.GetHashCode() ?? 0;

    /// <summary>Equality operator.</summary>
    public static bool operator ==(Offset left, Offset right) => left.Equals(right);

    /// <summary>Inequality operator.</summary>
    public static bool operator !=(Offset left, Offset right) => !left.Equals(right);

    /// <summary>Less than operator (lexicographic).</summary>
    public static bool operator <(Offset left, Offset right) => left.CompareTo(right) < 0;

    /// <summary>Greater than operator (lexicographic).</summary>
    public static bool operator >(Offset left, Offset right) => left.CompareTo(right) > 0;

    /// <summary>Less than or equal operator.</summary>
    public static bool operator <=(Offset left, Offset right) => left.CompareTo(right) <= 0;

    /// <summary>Greater than or equal operator.</summary>
    public static bool operator >=(Offset left, Offset right) => left.CompareTo(right) >= 0;
}
