package com.durablestreams;

import java.util.*;
import java.util.regex.*;

/**
 * Minimal JSON parser for the conformance adapter.
 * Only implements features needed for the adapter protocol.
 */
public final class Json {

    private Json() {}

    /**
     * Parse a JSON string into a Map or List.
     */
    public static Object parse(String json) {
        return new Parser(json).parse();
    }

    /**
     * Parse a JSON string into a Map.
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String json) {
        Object result = parse(json);
        if (result instanceof Map) {
            return (Map<String, Object>) result;
        }
        throw new RuntimeException("Expected JSON object, got: " + (result != null ? result.getClass() : "null"));
    }

    /**
     * Stringify an object to JSON.
     */
    public static String stringify(Object obj) {
        return new Stringifier().stringify(obj);
    }

    private static class Parser {
        private final String json;
        private int pos = 0;

        Parser(String json) {
            this.json = json;
        }

        Object parse() {
            skipWhitespace();
            Object value = parseValue();
            skipWhitespace();
            return value;
        }

        private Object parseValue() {
            skipWhitespace();
            if (pos >= json.length()) return null;

            char c = json.charAt(pos);
            switch (c) {
                case '{': return parseObject();
                case '[': return parseArray();
                case '"': return parseString();
                case 't': return parseTrue();
                case 'f': return parseFalse();
                case 'n': return parseNull();
                default:
                    if (c == '-' || Character.isDigit(c)) {
                        return parseNumber();
                    }
                    throw new RuntimeException("Unexpected character: " + c + " at position " + pos);
            }
        }

        private Map<String, Object> parseObject() {
            Map<String, Object> map = new LinkedHashMap<>();
            expect('{');
            skipWhitespace();

            if (pos < json.length() && json.charAt(pos) == '}') {
                pos++;
                return map;
            }

            while (true) {
                skipWhitespace();
                String key = parseString();
                skipWhitespace();
                expect(':');
                Object value = parseValue();
                map.put(key, value);
                skipWhitespace();

                if (pos >= json.length()) break;
                char c = json.charAt(pos);
                if (c == '}') {
                    pos++;
                    break;
                } else if (c == ',') {
                    pos++;
                } else {
                    throw new RuntimeException("Expected ',' or '}' at position " + pos);
                }
            }
            return map;
        }

        private List<Object> parseArray() {
            List<Object> list = new ArrayList<>();
            expect('[');
            skipWhitespace();

            if (pos < json.length() && json.charAt(pos) == ']') {
                pos++;
                return list;
            }

            while (true) {
                Object value = parseValue();
                list.add(value);
                skipWhitespace();

                if (pos >= json.length()) break;
                char c = json.charAt(pos);
                if (c == ']') {
                    pos++;
                    break;
                } else if (c == ',') {
                    pos++;
                } else {
                    throw new RuntimeException("Expected ',' or ']' at position " + pos);
                }
            }
            return list;
        }

        private String parseString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (pos < json.length()) {
                char c = json.charAt(pos++);
                if (c == '"') {
                    return sb.toString();
                } else if (c == '\\') {
                    if (pos >= json.length()) break;
                    char escaped = json.charAt(pos++);
                    switch (escaped) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            if (pos + 4 <= json.length()) {
                                String hex = json.substring(pos, pos + 4);
                                sb.append((char) Integer.parseInt(hex, 16));
                                pos += 4;
                            }
                            break;
                        default: sb.append(escaped);
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new RuntimeException("Unterminated string");
        }

        private Number parseNumber() {
            int start = pos;
            if (json.charAt(pos) == '-') pos++;
            while (pos < json.length() && Character.isDigit(json.charAt(pos))) pos++;
            if (pos < json.length() && json.charAt(pos) == '.') {
                pos++;
                while (pos < json.length() && Character.isDigit(json.charAt(pos))) pos++;
            }
            if (pos < json.length() && (json.charAt(pos) == 'e' || json.charAt(pos) == 'E')) {
                pos++;
                if (pos < json.length() && (json.charAt(pos) == '+' || json.charAt(pos) == '-')) pos++;
                while (pos < json.length() && Character.isDigit(json.charAt(pos))) pos++;
            }
            String numStr = json.substring(start, pos);
            if (numStr.contains(".") || numStr.contains("e") || numStr.contains("E")) {
                return Double.parseDouble(numStr);
            }
            long val = Long.parseLong(numStr);
            if (val >= Integer.MIN_VALUE && val <= Integer.MAX_VALUE) {
                return (int) val;
            }
            return val;
        }

        private Boolean parseTrue() {
            expect("true");
            return Boolean.TRUE;
        }

        private Boolean parseFalse() {
            expect("false");
            return Boolean.FALSE;
        }

        private Object parseNull() {
            expect("null");
            return null;
        }

        private void expect(char c) {
            if (pos >= json.length() || json.charAt(pos) != c) {
                throw new RuntimeException("Expected '" + c + "' at position " + pos);
            }
            pos++;
        }

        private void expect(String s) {
            for (char c : s.toCharArray()) {
                expect(c);
            }
        }

        private void skipWhitespace() {
            while (pos < json.length() && Character.isWhitespace(json.charAt(pos))) {
                pos++;
            }
        }
    }

    private static class Stringifier {
        private final StringBuilder sb = new StringBuilder();

        String stringify(Object obj) {
            write(obj);
            return sb.toString();
        }

        private void write(Object obj) {
            if (obj == null) {
                sb.append("null");
            } else if (obj instanceof Boolean) {
                sb.append(obj);
            } else if (obj instanceof Number) {
                sb.append(obj);
            } else if (obj instanceof String) {
                writeString((String) obj);
            } else if (obj instanceof Map) {
                writeObject((Map<?, ?>) obj);
            } else if (obj instanceof List) {
                writeArray((List<?>) obj);
            } else {
                writeString(obj.toString());
            }
        }

        private void writeString(String s) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\b': sb.append("\\b"); break;
                    case '\f': sb.append("\\f"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    default:
                        if (c < 0x20) {
                            sb.append(String.format("\\u%04x", (int) c));
                        } else {
                            sb.append(c);
                        }
                }
            }
            sb.append('"');
        }

        private void writeObject(Map<?, ?> map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeString(entry.getKey().toString());
                sb.append(':');
                write(entry.getValue());
            }
            sb.append('}');
        }

        private void writeArray(List<?> list) {
            sb.append('[');
            boolean first = true;
            for (Object item : list) {
                if (!first) sb.append(',');
                first = false;
                write(item);
            }
            sb.append(']');
        }
    }
}
