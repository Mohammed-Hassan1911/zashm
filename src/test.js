import { useEffect } from "react"
import { supabase } from "./lib/supabase"

export default function TestSupabase() {

  useEffect(() => {
    test()
  }, [])

  async function test() {
    const { data, error } = await supabase
      .from('products')
      .select('*')

    console.log("DATA:", data)
    console.log("ERROR:", error)
  }

  return <h1>Check Console</h1>
}