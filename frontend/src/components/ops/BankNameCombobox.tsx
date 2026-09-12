import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { INDIAN_BANKS } from "@/data/indianBanks";

const OTHER_VALUE = "__other__";

// Searchable "Bank name" picker: a list of Indian banks with a search box,
// plus an always-present "Not listed — type it myself" option that swaps to
// a plain text input. If the incoming value isn't one of the listed banks
// (an existing resource who typed something custom before this existed, or
// a bank genuinely not on the list), it opens straight into manual mode
// rather than silently discarding what they already entered.
export function BankNameCombobox({
  value,
  onChange,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState(() => value !== "" && !INDIAN_BANKS.includes(value));

  useEffect(() => {
    if (value !== "" && !INDIAN_BANKS.includes(value)) setManual(true);
  }, [value]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return INDIAN_BANKS;
    return INDIAN_BANKS.filter((bank) => bank.toLowerCase().includes(q));
  }, [search]);

  if (manual) {
    return (
      <div className="flex flex-col gap-1.5">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter bank name"
          className={`h-11 bg-card text-[13px] tab:h-9 ${className}`}
        />
        <button
          type="button"
          onClick={() => {
            setManual(false);
            setSearch("");
          }}
          className="cursor-pointer self-start text-[11px] text-primary underline-offset-4 hover:underline"
        >
          Choose from list instead
        </button>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={`h-11 w-full justify-between bg-card text-[13px] font-normal tab:h-9 ${className}`}
        >
          <span className={cn("truncate text-left", !value && "text-muted-foreground")}>
            {value || "Select bank name"}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(320px,90vw)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search bank..."
            className="text-[13px]"
          />
          <CommandList>
            <CommandEmpty className="px-3 py-4 text-[13px] text-muted-foreground">
              No bank found.
            </CommandEmpty>
            <CommandGroup>
              {filtered.map((bank) => (
                <CommandItem
                  key={bank}
                  value={bank}
                  onSelect={() => {
                    onChange(bank);
                    setOpen(false);
                    setSearch("");
                  }}
                  className="text-[13px]"
                >
                  <Check className={cn("mr-2 size-4", value === bank ? "opacity-100" : "opacity-0")} />
                  {bank}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup>
              <CommandItem
                value={OTHER_VALUE}
                onSelect={() => {
                  setManual(true);
                  setOpen(false);
                  setSearch("");
                }}
                className="text-[13px] text-muted-foreground"
              >
                Not listed — type it myself
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
